import { randomBytes, randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { authenticated, consumeEmailCode, createEmailCode, emailAllowed, hubUrl, isHub, tokenHash } from './auth.js'
import type { Database } from './database.js'
import type { Mailer } from './mail.js'

const VIEWER_COOKIE = 'share_viewer'
const VIEWER_DAYS = 7
const email = z.string().trim().email().max(254).transform((value) => value.toLowerCase())
const shareSettings = z.object({
  access: z.enum(['public', 'emails']),
  emails: z.array(email).max(100),
  expiresAt: z.iso.datetime().nullable(),
})
const newShare = shareSettings.extend({ kind: z.enum(['session', 'project']), title: z.string().trim().min(1).max(200) })
// The local monitor already strips chat and paths; the hub drops the chat again so it never stores any.
const detailSchema = z.looseObject({ timeline: z.array(z.looseObject({})).max(200_000) })

type ShareRow = {
  id: string; user_id: string; kind: string; title: string; access: string; emails: string
  expires_at: string | null; data: string | null; updated_at: string | null; created_at: string
}

const expired = { error: { message: 'Sua sessão expirou. Entre novamente.' } }
const notFound = { error: { message: 'Link inválido, expirado ou revogado.' } }
const publicOff = { error: { message: 'Links públicos estão desativados neste hub.' } }

/** HUB_ALLOW_PUBLIC_SHARES=false keeps every share behind an e-mail list. */
const publicAllowed = () => process.env.HUB_ALLOW_PUBLIC_SHARES !== 'false'

function summary(row: ShareRow) {
  return {
    id: row.id, kind: row.kind, title: row.title, access: row.access, emails: JSON.parse(row.emails) as string[],
    expiresAt: row.expires_at, updatedAt: row.updated_at, createdAt: row.created_at,
  }
}

export function registerHubRoutes(app: FastifyInstance, db: Database, mail: Mailer): void {
  const requireUser = authenticated(db)
  // Share id → open streams of that share.
  const streams = new Map<string, Set<(data: string) => void>>()
  const ends = new Set<FastifyReply['raw']>()
  app.addHook('preClose', async () => {
    for (const end of ends) end.end()
  })

  // The local monitor calls with its key; the hub page calls with the login cookie.
  const owner = (request: FastifyRequest): string | undefined => {
    const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1]
    if (!bearer) return requireUser(request)?.id
    const row = db.prepare(`SELECT u.id, u.email FROM ingest_keys k JOIN users u ON u.id = k.user_id
      WHERE k.key_hash = ? AND u.verified_at IS NOT NULL`).get(tokenHash(bearer)) as { id: string; email: string } | undefined
    return row && emailAllowed(row.email) ? row.id : undefined
  }
  const ownShare = (id: string, userId: string) =>
    db.prepare('SELECT * FROM shares WHERE id = ? AND user_id = ?').get(id, userId) as ShareRow | undefined

  // Shown once: only the hash is kept, and a new key replaces the old one.
  app.post('/v1/hub/key', async (request, reply) => {
    const user = requireUser(request)
    if (!user) return reply.code(401).send(expired)
    const key = `tw_${randomBytes(32).toString('base64url')}`
    db.prepare(`INSERT INTO ingest_keys (user_id, key_hash, created_at) VALUES (?, ?, ?)
      ON CONFLICT (user_id) DO UPDATE SET key_hash = excluded.key_hash, created_at = excluded.created_at`)
      .run(user.id, tokenHash(key), new Date().toISOString())
    return { key }
  })

  app.get('/v1/hub/shares', async (request, reply) => {
    const userId = owner(request)
    if (!userId) return reply.code(401).send(expired)
    const rows = db.prepare('SELECT * FROM shares WHERE user_id = ? ORDER BY created_at DESC').all(userId) as ShareRow[]
    return { shares: rows.map(summary) }
  })

  // The link carries the only copy of the token, so the caller must keep it to show it again.
  app.post('/v1/hub/shares', async (request, reply) => {
    const userId = owner(request)
    if (!userId) return reply.code(401).send(expired)
    const input = newShare.parse(request.body)
    if (input.access === 'public' && !publicAllowed()) return reply.code(403).send(publicOff)
    const token = randomBytes(32).toString('base64url')
    const id = randomUUID()
    db.prepare(`INSERT INTO shares (id, user_id, token_hash, kind, title, access, emails, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, userId, tokenHash(token), input.kind, input.title, input.access, JSON.stringify(input.emails), input.expiresAt, new Date().toISOString())
    return reply.code(201).send({ share: summary(ownShare(id, userId)!), url: `${hubUrl()}/s/${token}` })
  })

  app.put<{ Params: { id: string } }>('/v1/hub/shares/:id', async (request, reply) => {
    const userId = owner(request)
    if (!userId) return reply.code(401).send(expired)
    if (!ownShare(request.params.id, userId)) return reply.code(404).send(notFound)
    const input = shareSettings.parse(request.body)
    if (input.access === 'public' && !publicAllowed()) return reply.code(403).send(publicOff)
    db.prepare('UPDATE shares SET access = ?, emails = ?, expires_at = ? WHERE id = ?')
      .run(input.access, JSON.stringify(input.emails), input.expiresAt, request.params.id)
    return { share: summary(ownShare(request.params.id, userId)!) }
  })

  // Revoking deletes the data with the row: nothing of a revoked share stays on the hub.
  app.delete<{ Params: { id: string } }>('/v1/hub/shares/:id', async (request, reply) => {
    const userId = owner(request)
    if (!userId) return reply.code(401).send(expired)
    const { changes } = db.prepare('DELETE FROM shares WHERE id = ? AND user_id = ?').run(request.params.id, userId)
    // Listeners re-check the share, so open viewers are cut now instead of on the next update.
    if (changes) for (const listener of streams.get(request.params.id) ?? []) listener('')
    return { ok: true }
  })

  app.put<{ Params: { id: string } }>('/v1/hub/shares/:id/data', { bodyLimit: 20 * 1024 * 1024 }, async (request, reply) => {
    const userId = owner(request)
    if (!userId) return reply.code(401).send(expired)
    if (!ownShare(request.params.id, userId)) return reply.code(404).send(notFound)
    const detail = detailSchema.parse(request.body)
    const data = JSON.stringify({ ...detail, messages: [], messageStart: 0, timeline: detail.timeline.map((point) => ({ ...point, prompt: '' })) })
    db.prepare('UPDATE shares SET data = ?, updated_at = ? WHERE id = ?').run(data, new Date().toISOString(), request.params.id)
    for (const send of streams.get(request.params.id) ?? []) send(data)
    return { ok: true }
  })

  // --- Viewer side: whoever opens /s/:token ---

  const viewerEmail = (request: FastifyRequest): string | undefined => {
    const token = request.cookies[VIEWER_COOKIE]
    if (token) {
      const row = db.prepare('SELECT email FROM viewer_sessions WHERE token_hash = ? AND expires_at > ?').get(tokenHash(token), new Date().toISOString()) as { email: string } | undefined
      if (row) return row.email
    }
    return requireUser(request)?.email
  }
  const liveShare = (token: string) =>
    db.prepare('SELECT * FROM shares WHERE token_hash = ? AND (expires_at IS NULL OR expires_at > ?)').get(tokenHash(token), new Date().toISOString()) as ShareRow | undefined
  // The owner always sees their own share; the env can turn public links off after they were made.
  const canView = (share: ShareRow, request: FastifyRequest) => {
    if (share.access === 'public') return publicAllowed()
    if (requireUser(request)?.id === share.user_id) return true
    const viewer = viewerEmail(request)
    return !!viewer && (JSON.parse(share.emails) as string[]).includes(viewer)
  }
  const open = (request: FastifyRequest<{ Params: { token: string } }>, reply: FastifyReply) => {
    const share = liveShare(request.params.token)
    if (!share) return void reply.code(404).send(notFound)
    if (!canView(share, request)) return void reply.code(403).send({ error: { message: 'Este link pede acesso por e-mail.' }, access: share.access })
    return share
  }

  app.get<{ Params: { token: string } }>('/v1/share/:token', async (request, reply) => {
    const share = open(request, reply)
    if (!share) return reply
    return { title: share.title, kind: share.kind, updatedAt: share.updated_at, detail: share.data ? JSON.parse(share.data) : null }
  })

  app.get<{ Params: { token: string } }>('/v1/share/:token/stream', async (request, reply) => {
    const share = open(request, reply)
    if (!share) return reply
    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    // A first comment flushes the headers through proxies, so the page knows it is live right away.
    raw.write(': open\n\n')
    const send = (data: string) => raw.write(`event: update\ndata: ${data}\n\n`)
    // Each update re-checks the share, so a revoked or expired link stops right away.
    const listener = (data: string) => (liveShare(request.params.token) ? send(data) : raw.end())
    const listeners = streams.get(share.id) ?? new Set()
    streams.set(share.id, listeners.add(listener))
    ends.add(raw)
    const ping = setInterval(() => raw.write(': ping\n\n'), 25_000)
    request.raw.on('close', () => {
      listeners.delete(listener)
      if (!listeners.size) streams.delete(share.id)
      ends.delete(raw)
      clearInterval(ping)
    })
  })

  // Always answers the same, so the form does not reveal which e-mails are on a list.
  app.post<{ Params: { token: string } }>('/v1/share/:token/access', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (request, reply) => {
    const input = z.object({ email }).parse(request.body)
    const share = liveShare(request.params.token)
    if (share?.access === 'emails' && (JSON.parse(share.emails) as string[]).includes(input.email)) {
      const code = createEmailCode(db, 'viewer', input.email, 15)
      await mail(input.email, `Acesso a "${share.title}" no TokenLens`, `Abra o link para ver o que foi compartilhado com você:\n\n${hubUrl()}/s/${request.params.token}#access=${code}\n\nO link vale por 15 minutos e só pode ser usado uma vez.`)
    }
    return reply.code(202).send({ ok: true })
  })

  // The code arrives in the URL fragment, which never reaches server logs, and the page posts it here.
  app.post('/v1/share/access/confirm', async (request, reply) => {
    const { code } = z.object({ code: z.string().max(100) }).parse(request.body)
    const address = consumeEmailCode(db, 'viewer', code)
    if (!address) return reply.code(400).send({ error: { message: 'Link de acesso inválido ou expirado. Peça outro.' } })
    const token = randomBytes(32).toString('base64url')
    db.prepare('INSERT INTO viewer_sessions (token_hash, email, expires_at) VALUES (?, ?, ?)')
      .run(tokenHash(token), address, new Date(Date.now() + VIEWER_DAYS * 24 * 60 * 60 * 1000).toISOString())
    reply.setCookie(VIEWER_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: isHub(), path: '/', maxAge: VIEWER_DAYS * 24 * 60 * 60 })
    return { email: address }
  })
}
