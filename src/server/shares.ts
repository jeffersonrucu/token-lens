import { basename } from 'node:path'
import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { authenticated } from './auth.js'
import type { Database } from './database.js'
import { readPrivacy } from './privacy.js'
import type { SessionDetail } from './session-detail.js'
import type { SessionUsage, UsageRoutes, UsageTracker } from './usage.js'

type Detail = SessionDetail & { session: SessionUsage }
type Settings = { url: string; api_key: string }
type LocalShare = { id: string; user_id: string; kind: 'session' | 'project'; scope: string; title: string; url: string; created_at: string }

const SYNC_MS = 30_000
const expired = { error: { message: 'Sua sessão expirou. Entre novamente.' } }
const notConnected = { error: { message: 'Conecte um hub em Conta → Compartilhamento antes de compartilhar.' } }
const email = z.string().trim().email().max(254)
const shareSettings = z.object({
  access: z.enum(['public', 'emails']),
  emails: z.array(email).max(100),
  expiresAt: z.iso.datetime().nullable(),
})
// Plain http only for a hub on this machine, so a key never crosses the network in clear text.
const hubUrl = z.string().trim().url().max(500).transform((url) => url.replace(/\/+$/, ''))
  .refine((url) => { const { protocol, hostname } = new URL(url); return protocol === 'https:' || ['localhost', '127.0.0.1'].includes(hostname) }, 'Use uma URL https.')

/** Only numbers leave the machine: no chat, prompts, paths, task descriptions, hook commands, command args or other sessions' ids. */
export function shareable(detail: Detail, title: string): Detail {
  return {
    ...detail,
    // A project's id is its path, so no id goes out at all.
    session: { ...detail.session, id: '', title, project: null },
    messages: [],
    clear: undefined,
    agents: detail.agents.map((agent) => ({ ...agent, description: agent.id === 'main' ? agent.description : '' })),
    commands: detail.commands.map((command) => ({ ...command, name: command.name.split(/\s/)[0]! })),
    hooks: detail.hooks.map((hook, index) => ({ ...hook, command: `#${index + 1}` })),
    timeline: detail.timeline.map((point) => ({ ...point, agent: point.agent.split(':')[0]!, prompt: '' })),
  }
}

class HubError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function hubFetch<T>(settings: Settings, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${settings.url}/api/v1${path}`, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${settings.api_key}`, ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => { throw new HubError('Não foi possível falar com o hub. Confira a URL e a conexão.', 502) })
  if (response.status === 401) throw new HubError('O hub recusou a chave. Gere uma nova no hub e conecte de novo.', 502)
  const body = await response.json().catch(() => ({})) as { error?: { message?: string } }
  if (!response.ok) throw new HubError(body.error?.message ?? `O hub respondeu ${response.status}.`, response.status >= 500 ? 502 : response.status)
  return body as T
}

export function registerShareRoutes(app: FastifyInstance, db: Database, usage: UsageTracker, routes: UsageRoutes): void {
  const requireUser = authenticated(db)
  const settingsOf = (userId: string) => db.prepare('SELECT url, api_key FROM hub_settings WHERE user_id = ?').get(userId) as Settings | undefined
  const fail = (reply: FastifyReply, error: unknown) => {
    if (error instanceof HubError) return reply.code(error.status).send({ error: { message: error.message } })
    throw error
  }

  // The default the dialog offers; the user may type any other before sharing.
  const defaultTitle = (share: Pick<LocalShare, 'kind' | 'scope' | 'user_id'>, detail: Detail) => {
    const { hidePaths } = readPrivacy(db, share.user_id)
    const day = new Date(detail.session.firstAt).toLocaleDateString('pt-BR')
    if (share.kind === 'project') return hidePaths ? `Projeto de ${day}` : basename(share.scope)
    // Session titles come from the first prompt, so they stay home when paths are hidden.
    return hidePaths || !detail.session.title ? `Sessão de ${day}` : detail.session.title.slice(0, 200)
  }
  const read = (share: Pick<LocalShare, 'kind' | 'scope' | 'user_id'>) =>
    share.kind === 'session' ? routes.sessionDetail(share.scope, share.user_id) : routes.projectDetail(share.scope, share.user_id)

  // A paused account sends nothing; a share whose data it can no longer see just stops updating.
  const push = async (share: LocalShare, log: FastifyBaseLogger) => {
    const settings = settingsOf(share.user_id)
    if (!settings || readPrivacy(db, share.user_id).paused) return
    const detail = await read(share)
    if (!detail) return
    await hubFetch(settings, `/hub/shares/${share.id}/data`, { method: 'PUT', body: shareable(detail, share.title) })
      .catch((error: unknown) => log.warn({ share: share.id, error: String(error) }, 'share não enviado ao hub'))
  }

  // ponytail: one timer for every share; per-share debounce if 30 s ever feels slow.
  const dirty = new Set<string>()
  const unsubscribe = usage.subscribe((event, sessions) => {
    if (event !== 'update') return
    const shares = db.prepare('SELECT * FROM local_shares').all() as LocalShare[]
    for (const share of shares) {
      if (sessions.some((session) => share.kind === 'session' ? session.id === share.scope : session.project === share.scope)) dirty.add(share.id)
    }
  })
  const timer = setInterval(() => {
    for (const id of dirty) {
      dirty.delete(id)
      const share = db.prepare('SELECT * FROM local_shares WHERE id = ?').get(id) as LocalShare | undefined
      if (share) void push(share, app.log)
    }
  }, SYNC_MS)
  app.addHook('onClose', async () => {
    clearInterval(timer)
    unsubscribe()
  })

  // The key never goes back to the page: it only learns whether one is saved.
  app.get('/v1/hub/settings', async (request, reply) => {
    const user = requireUser(request)
    if (!user) return reply.code(401).send(expired)
    const settings = settingsOf(user.id)
    return { url: settings?.url ?? null, connected: !!settings }
  })

  // Saving tests the key against the hub first, so a typo fails here and not on the first share.
  app.put('/v1/hub/settings', async (request, reply) => {
    const user = requireUser(request)
    if (!user) return reply.code(401).send(expired)
    const input = z.object({ url: hubUrl, key: z.string().trim().min(10).max(200) }).parse(request.body)
    const settings = { url: input.url, api_key: input.key }
    try {
      await hubFetch(settings, '/hub/shares')
    } catch (error) {
      return fail(reply, error)
    }
    db.prepare(`INSERT INTO hub_settings (user_id, url, api_key) VALUES (?, ?, ?)
      ON CONFLICT (user_id) DO UPDATE SET url = excluded.url, api_key = excluded.api_key`).run(user.id, settings.url, settings.api_key)
    return { url: settings.url, connected: true }
  })

  // Disconnecting only stops sending; links already made keep their last data until revoked.
  app.delete('/v1/hub/settings', async (request, reply) => {
    const user = requireUser(request)
    if (!user) return reply.code(401).send(expired)
    db.prepare('DELETE FROM hub_settings WHERE user_id = ?').run(user.id)
    return { url: null, connected: false }
  })

  const scopeQuery = z.object({ kind: z.enum(['session', 'project']), scope: z.string().min(1).max(4096) })

  // The hub holds access and expiry; this machine holds the link, which the hub cannot show again.
  app.get('/v1/shares', async (request, reply) => {
    const user = requireUser(request)
    if (!user) return reply.code(401).send(expired)
    const settings = settingsOf(user.id)
    if (!settings) return { shares: [] }
    const { kind, scope } = scopeQuery.parse(request.query)
    const local = db.prepare('SELECT * FROM local_shares WHERE user_id = ? AND kind = ? AND scope = ? ORDER BY created_at DESC').all(user.id, kind, scope) as LocalShare[]
    if (!local.length) return { shares: [] }
    try {
      const { shares } = await hubFetch<{ shares: { id: string }[] }>(settings, '/hub/shares')
      const remote = new Map(shares.map((share) => [share.id, share]))
      // A share revoked on the hub page is gone for good, so its local copy goes too.
      for (const share of local) if (!remote.has(share.id)) db.prepare('DELETE FROM local_shares WHERE id = ?').run(share.id)
      return { shares: local.flatMap((share) => remote.has(share.id) ? [{ ...remote.get(share.id), url: share.url }] : []) }
    } catch (error) {
      return fail(reply, error)
    }
  })

  app.get('/v1/shares/default-title', async (request, reply) => {
    const user = requireUser(request)
    if (!user) return reply.code(401).send(expired)
    const draft = { ...scopeQuery.parse(request.query), user_id: user.id }
    const detail = await read(draft)
    if (!detail) return reply.code(404).send({ error: { message: 'Nada para compartilhar aqui.' } })
    return { title: defaultTitle(draft, detail) }
  })

  app.post('/v1/shares', async (request, reply) => {
    const user = requireUser(request)
    if (!user) return reply.code(401).send(expired)
    const settings = settingsOf(user.id)
    if (!settings) return reply.code(409).send(notConnected)
    const input = scopeQuery.merge(shareSettings).extend({ title: z.string().trim().min(1).max(200).optional() }).parse(request.body)
    const draft = { kind: input.kind, scope: input.scope, user_id: user.id }
    const detail = await read(draft)
    if (!detail) return reply.code(404).send({ error: { message: 'Nada para compartilhar aqui.' } })
    const title = input.title ?? defaultTitle(draft, detail)
    try {
      const { share, url } = await hubFetch<{ share: { id: string }; url: string }>(settings, '/hub/shares', {
        method: 'POST',
        body: { kind: input.kind, title, access: input.access, emails: input.emails, expiresAt: input.expiresAt },
      })
      const local: LocalShare = { ...draft, id: share.id, title, url, created_at: new Date().toISOString() }
      db.prepare('INSERT INTO local_shares (id, user_id, kind, scope, title, url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(local.id, user.id, local.kind, local.scope, local.title, local.url, local.created_at)
      await push(local, request.log)
      return reply.code(201).send({ share: { ...share, url } })
    } catch (error) {
      return fail(reply, error)
    }
  })

  const ownShare = (id: string, userId: string) => db.prepare('SELECT * FROM local_shares WHERE id = ? AND user_id = ?').get(id, userId) as LocalShare | undefined

  app.put<{ Params: { id: string } }>('/v1/shares/:id', async (request, reply) => {
    const user = requireUser(request)
    if (!user) return reply.code(401).send(expired)
    const settings = settingsOf(user.id)
    const local = ownShare(request.params.id, user.id)
    if (!settings || !local) return reply.code(404).send({ error: { message: 'Compartilhamento não encontrado.' } })
    const input = shareSettings.parse(request.body)
    try {
      const { share } = await hubFetch<{ share: object }>(settings, `/hub/shares/${local.id}`, { method: 'PUT', body: input })
      return { share: { ...share, url: local.url } }
    } catch (error) {
      return fail(reply, error)
    }
  })

  // Revokes on the hub first: the local link is removed only once the data there is gone.
  app.delete<{ Params: { id: string } }>('/v1/shares/:id', async (request, reply) => {
    const user = requireUser(request)
    if (!user) return reply.code(401).send(expired)
    const settings = settingsOf(user.id)
    const local = ownShare(request.params.id, user.id)
    if (!settings || !local) return reply.code(404).send({ error: { message: 'Compartilhamento não encontrado.' } })
    try {
      await hubFetch(settings, `/hub/shares/${local.id}`, { method: 'DELETE' })
    } catch (error) {
      return fail(reply, error)
    }
    db.prepare('DELETE FROM local_shares WHERE id = ?').run(local.id)
    return { ok: true }
  })
}
