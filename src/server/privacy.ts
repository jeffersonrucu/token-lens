import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticated } from './auth.js'
import type { Database } from './database.js'
import type { SessionUsage, UsageTracker } from './usage.js'

const privacySchema = z.object({
  mode: z.enum(['auto', 'manual']),
  projects: z.array(z.string().max(4096).refine(isAbsolute, 'Caminho de pasta inválido.')).max(200),
  paused: z.boolean(),
  hideChat: z.boolean(),
  hidePaths: z.boolean(),
})
// `since` is only set by the history routes, so a stale page saving its settings never moves it.
export type Privacy = z.infer<typeof privacySchema> & { since: string | null }

export const DEFAULT_PRIVACY: Privacy = { mode: 'auto', projects: [], paused: false, hideChat: false, hidePaths: false, since: null }
const expired = { error: { message: 'Sua sessão expirou. Entre novamente.' } }

export function readPrivacy(db: Database, userId: string): Privacy {
  const row = db.prepare('SELECT settings FROM privacy WHERE user_id = ?').get(userId) as { settings: string } | undefined
  return row ? { ...DEFAULT_PRIVACY, ...(JSON.parse(row.settings) as Partial<Privacy>) } : DEFAULT_PRIVACY
}

/** Whether the account sees the session: manual mode shows only the chosen folders and their subfolders. */
export function shows(privacy: Privacy, session: SessionUsage): boolean {
  if (privacy.mode === 'auto') return true
  const project = session.project
  return !!project && privacy.projects.some((path) => project === path || project.startsWith(`${path}${sep}`))
}

/** Claude Code names each history folder after the project path, with every non-alphanumeric char as '-'. */
export function historyFolder(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-')
}

/** History folders any active account needs, or null for all of them. */
export function readScope(db: Database): string[] | null {
  const users = db.prepare('SELECT id FROM users').all() as { id: string }[]
  // With no account yet, reading everything keeps the first sign-up instant.
  if (!users.length) return null
  const folders = new Set<string>()
  for (const { id } of users) {
    const privacy = readPrivacy(db, id)
    if (privacy.paused) continue
    if (privacy.mode === 'auto') return null
    for (const path of privacy.projects) folders.add(historyFolder(path))
  }
  return [...folders]
}

function writePrivacy(db: Database, userId: string, privacy: Privacy): void {
  db.prepare('INSERT INTO privacy (user_id, settings) VALUES (?, ?) ON CONFLICT (user_id) DO UPDATE SET settings = excluded.settings')
    .run(userId, JSON.stringify(privacy))
}

export function registerPrivacyRoutes(app: FastifyInstance, db: Database, usage: UsageTracker, onChange: (userId: string) => void): void {
  const requireUser = authenticated(db)
  usage.setScope(readScope(db))

  app.get('/v1/privacy', async (request, reply) => {
    const user = requireUser(request)
    if (!user) return reply.code(401).send(expired)
    return readPrivacy(db, user.id)
  })

  app.put('/v1/privacy', async (request, reply) => {
    const user = requireUser(request)
    if (!user) return reply.code(401).send(expired)
    const input = privacySchema.parse(request.body)
    const privacy = { ...input, projects: [...new Set(input.projects.map((path) => resolve(path)))], since: readPrivacy(db, user.id).since }
    writePrivacy(db, user.id, privacy)
    // Choosing a folder by hand is a clear sign it should be watched again.
    for (const path of privacy.projects) {
      db.prepare('DELETE FROM ignored_projects WHERE path = ?').run(path)
      usage.unignore(path)
    }
    usage.setScope(readScope(db))
    onChange(user.id)
    return privacy
  })

  // The browser's own folder picker hides the absolute path, so the page browses through the API.
  app.get('/v1/folders', async (request, reply) => {
    if (!requireUser(request)) return reply.code(401).send(expired)
    const query = z.object({ path: z.string().max(4096).refine(isAbsolute).optional() }).parse(request.query)
    const path = resolve(query.path ?? homedir())
    const entries = await readdir(path, { withFileTypes: true }).catch(() => undefined)
    if (!entries) return reply.code(404).send({ error: { message: 'Não foi possível abrir esta pasta.' } })
    // More than one Claude root on Windows, where the history usually also lives inside WSL.
    const roots = usage.sources.filter((source) => source.harness === 'claude')
    const history = new Set((await Promise.all(roots.map((source) => readdir(source.root).catch(() => [])))).flat())
    // Codex and pi do not name folders after the project, so their sessions tell it.
    const projects = new Set(usage.list().map((session) => session.project))
    const hasSessions = (folder: string) => history.has(historyFolder(folder)) || projects.has(folder)
    const folders = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(path, entry.name))
      .sort((a, b) => a.localeCompare(b))
      .map((folder) => ({ path: folder, hasSessions: hasSessions(folder) }))
    return { path, parent: path === dirname(path) ? null : dirname(path), hasSessions: hasSessions(path), folders }
  })

  // The dashboard opens only when Claude Code's history is readable and the account chose its privacy.
  app.post('/v1/onboarding', async (request, reply) => {
    const user = requireUser(request)
    if (!user) return reply.code(401).send(expired)
    const status = await usage.check()
    if (!status.ok) return reply.code(409).send({ error: { message: status.message } })
    const saved = db.prepare('SELECT settings FROM privacy WHERE user_id = ?').get(user.id)
    if (!saved) return reply.code(409).send({ error: { message: 'Confirme as configurações de privacidade antes de continuar.' } })
    const privacy = readPrivacy(db, user.id)
    if (privacy.mode === 'manual' && !privacy.projects.length) return reply.code(409).send({ error: { message: 'No modo manual, escolha ao menos uma pasta.' } })
    db.prepare('UPDATE users SET onboarded_at = ? WHERE id = ? AND onboarded_at IS NULL').run(new Date().toISOString(), user.id)
    return { user: { ...user, onboarded: true } }
  })

  // Old sessions stay on disk; the account just counts from now on.
  app.post('/v1/history/clear', async (request, reply) => {
    const user = requireUser(request)
    if (!user) return reply.code(401).send(expired)
    const privacy = { ...readPrivacy(db, user.id), since: new Date().toISOString() }
    writePrivacy(db, user.id, privacy)
    onChange(user.id)
    return privacy
  })

  // Brings back the whole history: no start date, removed projects restored, files read again.
  app.post('/v1/history/sync', async (request, reply) => {
    const user = requireUser(request)
    if (!user) return reply.code(401).send(expired)
    const privacy = { ...readPrivacy(db, user.id), since: null }
    writePrivacy(db, user.id, privacy)
    for (const { path } of db.prepare('SELECT path FROM ignored_projects').all() as { path: string }[]) usage.unignore(path)
    db.exec('DELETE FROM ignored_projects')
    await usage.scan()
    onChange(user.id)
    return privacy
  })

  app.post('/v1/privacy/clear-cache', async (request, reply) => {
    if (!requireUser(request)) return reply.code(401).send(expired)
    await usage.reset()
    return { ok: true }
  })
}
