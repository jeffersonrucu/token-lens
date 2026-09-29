import { createHash, randomBytes, randomUUID } from 'node:crypto'
import argon2 from 'argon2'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Database } from './database.js'
import type { Mailer } from './mail.js'

const COOKIE = 'monitor_session'
const SESSION_DAYS = 30
const hashOptions = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const
const email = z.string().trim().email().max(254).transform((value) => value.toLowerCase())
const signupSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email,
  password: z.string().min(8).max(256),
  avatarSeed: z.string().uuid(),
})
const loginSchema = z.object({ email, password: z.string().min(1).max(256) })
const deleteAccountSchema = z.object({ password: z.string().min(1).max(256) })
const sectionList = z.array(z.string().max(40)).max(50)
const preferencesSchema = z.object({ sectionOrder: sectionList, hiddenSections: sectionList })

type UserRow = { id: string; name: string; email: string; avatar_seed: string; password_hash: string; onboarded_at: string | null; verified_at: string | null }
export type Profile = { id: string; name: string; email: string; avatarSeed: string; onboarded: boolean }

function profile(user: UserRow): Profile {
  return { id: user.id, name: user.name, email: user.email, avatarSeed: user.avatar_seed, onboarded: !!user.onboarded_at }
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('base64url')
}

/** The shared hub, as opposed to the local monitor that reads this machine's history. */
export function isHub(): boolean {
  return process.env.MODE === 'hub'
}

export function hubUrl(): string {
  return (process.env.HUB_PUBLIC_URL ?? '').replace(/\/+$/, '')
}

/** With HUB_ALLOWED_EMAIL_DOMAINS set, only those domains may sign up, log in or keep a session. */
export function emailAllowed(address: string): boolean {
  const domains = (process.env.HUB_ALLOWED_EMAIL_DOMAINS ?? '').split(',').map((domain) => domain.trim().toLowerCase()).filter(Boolean)
  return !domains.length || domains.includes(address.slice(address.lastIndexOf('@') + 1).toLowerCase())
}

/** A single-use code sent by e-mail; only its hash is stored. */
export function createEmailCode(db: Database, purpose: 'verify' | 'viewer', address: string, minutes: number): string {
  const code = randomBytes(32).toString('base64url')
  db.prepare('INSERT INTO email_codes (code_hash, purpose, email, expires_at) VALUES (?, ?, ?, ?)')
    .run(tokenHash(code), purpose, address, new Date(Date.now() + minutes * 60_000).toISOString())
  return code
}

export function consumeEmailCode(db: Database, purpose: 'verify' | 'viewer', code: string): string | undefined {
  const row = db.prepare('DELETE FROM email_codes WHERE code_hash = ? AND purpose = ? RETURNING email, expires_at').get(tokenHash(code), purpose) as { email: string; expires_at: string } | undefined
  return row && row.expires_at > new Date().toISOString() ? row.email : undefined
}

const domainRefused = { error: { message: 'Use um e-mail de um domínio autorizado.' } }

function createSession(db: Database, reply: FastifyReply, userId: string): void {
  const token = randomBytes(32).toString('base64url')
  const now = new Date()
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString()
  db.prepare('INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(randomUUID(), userId, tokenHash(token), expiresAt, now.toISOString())
  reply.setCookie(COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: isHub(), path: '/', maxAge: SESSION_DAYS * 24 * 60 * 60 })
}

export function authenticated(db: Database) {
  return (request: FastifyRequest): Profile | undefined => {
    const token = request.cookies[COOKIE]
    if (!token) return undefined
    const user = db.prepare(`SELECT u.id, u.name, u.email, u.avatar_seed, u.password_hash, u.onboarded_at, u.verified_at
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`).get(tokenHash(token), new Date().toISOString()) as UserRow | undefined
    // Dropping a domain from the env ends that domain's open sessions too.
    return user && emailAllowed(user.email) ? profile(user) : undefined
  }
}

export function registerAuthRoutes(app: FastifyInstance, db: Database, mail: Mailer): void {
  const requireUser = authenticated(db)
  const emailLimit = { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }
  app.post('/v1/auth/signup', emailLimit, async (request, reply) => {
    const input = signupSchema.parse(request.body)
    if (!emailAllowed(input.email)) return reply.code(403).send(domainRefused)
    // An unconfirmed hub account is replaced, so a lost e-mail can be sent again.
    if (isHub()) db.prepare('DELETE FROM users WHERE email = ? AND verified_at IS NULL').run(input.email)
    if (db.prepare('SELECT id FROM users WHERE email = ?').get(input.email)) return reply.code(409).send({ error: { message: 'Já existe uma conta com este e-mail.' } })
    const now = new Date().toISOString()
    const user: UserRow = { id: randomUUID(), name: input.name, email: input.email, avatar_seed: input.avatarSeed, password_hash: await argon2.hash(input.password, hashOptions), onboarded_at: null, verified_at: isHub() ? null : now }
    db.prepare('INSERT INTO users (id, name, email, password_hash, avatar_seed, created_at, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(user.id, user.name, user.email, user.password_hash, user.avatar_seed, now, user.verified_at)
    if (isHub()) {
      const code = createEmailCode(db, 'verify', user.email, 24 * 60)
      await mail(user.email, 'Confirme seu e-mail no TokenLens', `Abra o link para confirmar sua conta:\n\n${hubUrl()}/api/v1/auth/verify?code=${code}\n\nO link vale por 24 horas.`)
      return reply.code(202).send({ pending: true })
    }
    createSession(db, reply, user.id)
    return reply.code(201).send({ user: profile(user) })
  })
  // Opened from the e-mail, so it answers with a redirect to the page instead of JSON.
  app.get('/v1/auth/verify', async (request, reply) => {
    const { code } = z.object({ code: z.string().max(100) }).parse(request.query)
    const address = consumeEmailCode(db, 'verify', code)
    // The hub reads no history, so there is no setup left after the e-mail.
    const now = new Date().toISOString()
    if (address) db.prepare('UPDATE users SET verified_at = ?, onboarded_at = ? WHERE email = ? AND verified_at IS NULL').run(now, now, address)
    return reply.redirect(`/?verified=${address ? 1 : 0}`)
  })
  app.post('/v1/auth/login', async (request, reply) => {
    const input = loginSchema.parse(request.body)
    const user = db.prepare('SELECT id, name, email, avatar_seed, password_hash, onboarded_at, verified_at FROM users WHERE email = ?').get(input.email) as UserRow | undefined
    if (!user || !(await argon2.verify(user.password_hash, input.password))) return reply.code(401).send({ error: { message: 'E-mail ou senha inválidos.' } })
    if (!emailAllowed(user.email)) return reply.code(403).send(domainRefused)
    if (!user.verified_at) return reply.code(403).send({ error: { message: 'Confirme seu e-mail antes de entrar.' } })
    createSession(db, reply, user.id)
    return { user: profile(user) }
  })
  app.post('/v1/auth/logout', async (request, reply) => {
    const token = request.cookies[COOKIE]
    if (token) db.prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ?').run(new Date().toISOString(), tokenHash(token))
    reply.clearCookie(COOKIE, { httpOnly: true, sameSite: 'strict', secure: isHub(), path: '/' })
    return { ok: true }
  })
  // Sessions, preferences and privacy go with the user through ON DELETE CASCADE.
  app.delete('/v1/account', async (request, reply) => {
    const user = requireUser(request)
    if (!user) return reply.code(401).send({ error: { message: 'Sua sessão expirou. Entre novamente.' } })
    const { password } = deleteAccountSchema.parse(request.body)
    const { password_hash } = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id) as { password_hash: string }
    if (!(await argon2.verify(password_hash, password))) return reply.code(403).send({ error: { message: 'Senha incorreta.' } })
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id)
    reply.clearCookie(COOKIE, { httpOnly: true, sameSite: 'strict', secure: isHub(), path: '/' })
    return { ok: true }
  })
  // Null until the user saves once, so the page can apply its own default.
  app.get('/v1/preferences', async (request, reply) => {
    const user = requireUser(request)
    if (!user) return reply.code(401).send({ error: { message: 'Sua sessão expirou. Entre novamente.' } })
    const row = db.prepare('SELECT section_order, hidden_sections FROM preferences WHERE user_id = ?').get(user.id) as { section_order: string; hidden_sections: string } | undefined
    if (!row) return { sectionOrder: null, hiddenSections: null }
    return { sectionOrder: JSON.parse(row.section_order) as string[], hiddenSections: JSON.parse(row.hidden_sections) as string[] }
  })
  app.put('/v1/preferences', async (request, reply) => {
    const user = requireUser(request)
    if (!user) return reply.code(401).send({ error: { message: 'Sua sessão expirou. Entre novamente.' } })
    const input = preferencesSchema.parse(request.body)
    db.prepare(`INSERT INTO preferences (user_id, section_order, hidden_sections) VALUES (?, ?, ?)
      ON CONFLICT (user_id) DO UPDATE SET section_order = excluded.section_order, hidden_sections = excluded.hidden_sections`)
      .run(user.id, JSON.stringify(input.sectionOrder), JSON.stringify(input.hiddenSections))
    return input
  })
  app.get('/v1/favorites', async (request, reply) => {
    const user = requireUser(request)
    if (!user) return reply.code(401).send({ error: { message: 'Sua sessão expirou. Entre novamente.' } })
    const rows = db.prepare('SELECT session_id, name, created_at FROM favorites WHERE user_id = ? ORDER BY created_at DESC, rowid DESC').all(user.id) as { session_id: string; name: string | null; created_at: string }[]
    return { favorites: rows.map((row) => ({ sessionId: row.session_id, name: row.name, createdAt: row.created_at })) }
  })
  // Stars the session, or renames a starred one; an empty name goes back to the session's own title.
  app.put<{ Params: { id: string } }>('/v1/favorites/:id', async (request, reply) => {
    const user = requireUser(request)
    if (!user) return reply.code(401).send({ error: { message: 'Sua sessão expirou. Entre novamente.' } })
    const { id } = z.object({ id: z.string().min(1).max(200) }).parse(request.params)
    const { name } = z.object({ name: z.string().trim().max(120).nullable() }).parse(request.body)
    db.prepare(`INSERT INTO favorites (user_id, session_id, name, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (user_id, session_id) DO UPDATE SET name = excluded.name`).run(user.id, id, name || null, new Date().toISOString())
    return { sessionId: id, name: name || null }
  })
  app.delete<{ Params: { id: string } }>('/v1/favorites/:id', async (request, reply) => {
    const user = requireUser(request)
    if (!user) return reply.code(401).send({ error: { message: 'Sua sessão expirou. Entre novamente.' } })
    db.prepare('DELETE FROM favorites WHERE user_id = ? AND session_id = ?').run(user.id, request.params.id)
    return { ok: true }
  })
  app.get('/v1/profile', async (request, reply) => {
    const user = requireUser(request)
    if (!user) return reply.code(401).send({ error: { message: 'Sua sessão expirou. Entre novamente.' } })
    return { user }
  })
}
