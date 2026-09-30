import { watch, type FSWatcher } from 'node:fs'
import { copyFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, sep } from 'node:path'
import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { authenticated } from './auth.js'
import type { Database } from './database.js'
import { codexCounts, readCodexDetail, readPiDetail, type CodexTokens } from './harnesses.js'
import { costOf, type Costs, type Usage } from './pricing.js'
import { readPrivacy, readScope, shows, type Privacy } from './privacy.js'
import { agentIdOf, mergeDetails, readAgentMeta, readSessionDetail, type SessionDetail } from './session-detail.js'

export type Harness = 'claude' | 'codex' | 'pi'
export type Source = { harness: Harness; root: string }

export type SessionUsage = {
  id: string
  harness: Harness
  title: string | null
  project: string | null
  models: string[]
  turns: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  // Estimated USD, summed per reply; replies of models without a price add nothing.
  cost: number
  firstAt: string
  lastAt: string
  // The agent deleted the transcript: the totals stay for the project, the session leaves the live list.
  lost?: boolean
}

export type ClaudeStatus =
  | { ok: true; root: string; sessions: number }
  | { ok: false; root: string; code: 'not-found' | 'no-access' | 'empty' | 'unreadable'; message: string }
type UsageEvent = 'snapshot' | 'update'
type Listener = (event: UsageEvent, sessions: SessionUsage[]) => void
type Counts = { input: number; output: number; cacheRead: number; cacheWrite: number }
// Keeps what each message id already added, so a later line of the same reply adds only the difference.
// `at` lets an account count a session only from its own start date.
type Seen = Counts & { at: string; cost: number }
type Tracked = SessionUsage & { seen: Map<string, Seen>; customTitle: boolean }
type CachedSession = SessionUsage & { seen: [string, Seen][]; customTitle: boolean }
// What an earlier line of a Codex or pi file said, since later lines only carry usage.
type FileContext = { session?: string; model?: string; cwd?: string; subagent?: boolean }
type Cache = { version: number; roots: string; files: [string, number][]; contexts: [string, FileContext][]; sessions: CachedSession[] }
// One line of any harness, reduced to what the totals need.
type Parsed = {
  session: string
  at?: string
  cwd?: string
  title?: string
  customTitle?: boolean
  // The first prompt, used only while the session has no other title.
  promptTitle?: boolean
  reply?: { id: string; model?: string; counts: Counts; cost: number }
}
type Line = {
  type?: string
  sessionId?: string
  cwd?: string
  timestamp?: string
  aiTitle?: string
  customTitle?: string
  message?: {
    id?: string
    model?: string
    usage?: Usage
  }
}

const NEWLINE = 0x0a
// Only lines holding one of these are decoded; the rest is prompts and tool output.
const NEEDLES: Record<Harness, Buffer[]> = {
  claude: ['"usage"', 'Title"'].map((text) => Buffer.from(text)),
  codex: ['"token_count"', '"session_meta"', '"turn_context"', '"UserMessage"'].map((text) => Buffer.from(text)),
  pi: ['"usage"', '"type":"session"', '"session_info"', '"role":"user"'].map((text) => Buffer.from(text)),
}
const TITLE_LIMIT = 80
const DEBOUNCE_MS = 300
const CHAT_PAGE = 50
const HOUR_MS = 3_600_000
const SAVE_EVERY_MS = 10_000
// fs.watch gets no events over a WSL share or a network drive: those roots are re-read on this interval.
const POLL_EVERY_MS = Number(process.env.MONITOR_POLL_MS ?? 3_000)
// Bounds the buffer on a cold start, when a long transcript is read from its first byte.
const READ_CHUNK = 4 * 1024 * 1024
// Bump when the cached shape or the counting rules change, so old caches are rebuilt.
const CACHE_VERSION = 5

const home = (variable: string, fallback: string) => process.env[variable] ?? join(homedir(), fallback)

/** Where each harness keeps its transcripts; Orca runs these same CLIs, so its sessions land here too. */
export function defaultSources(): Source[] {
  return [
    { harness: 'claude', root: process.env.CLAUDE_PROJECTS_DIR ?? join(home('CLAUDE_CONFIG_DIR', '.claude'), 'projects') },
    { harness: 'codex', root: process.env.CODEX_SESSIONS_DIR ?? join(home('CODEX_HOME', '.codex'), 'sessions') },
    { harness: 'pi', root: process.env.PI_SESSIONS_DIR ?? join(home('PI_CODING_AGENT_DIR', join('.pi', 'agent')), 'sessions') },
  ]
}

// An id becomes a folder name in the favorites archive.
const SAFE_ID = /^[\w-]+$/

// Codex and pi end every file name with the thread's UUID.
const fileUuid = (path: string) => /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(path)?.[1]

/** Tails Claude Code, Codex and pi transcripts and keeps per-session token totals in memory. */
export class UsageTracker {
  ready = false
  private readonly sessions = new Map<string, Tracked>()
  // Byte offset just past the last complete line read from each file.
  private readonly files = new Map<string, number>()
  private readonly contexts = new Map<string, FileContext>()
  // Files the agent deleted, and the sessions whose main transcript is among them.
  private readonly deleted = new Set<string>()
  private readonly gone = new Set<string>()
  // Favorites whose transcripts were copied under archiveRoot, out of the agent's cleanup.
  private readonly archived = new Set<string>()
  private readonly archiveRoot: string
  private readonly pending = new Set<string>()
  private readonly listeners = new Set<Listener>()
  // Removed projects: still tailed, never shown, so restoring one needs no re-read.
  private readonly ignored = new Set<string>()
  // History folders that may be read; null reads them all. Skipped files keep their offset and catch up later.
  private scope: string[] | null = null
  // Every read goes through this chain, so a file is never read twice from the same offset.
  private work: Promise<void> = Promise.resolve()
  private timer: NodeJS.Timeout | undefined
  private saveTimer: NodeJS.Timeout | undefined
  private pollTimer: NodeJS.Timeout | undefined
  private readonly watchers = new Map<string, FSWatcher>()
  private log: FastifyBaseLogger | undefined
  readonly sources: Source[]
  private readonly cachePath: string

  // A plain path is read as Claude Code's folder, the only harness before Codex and pi.
  constructor(
    sources: Source[] | string = defaultSources(),
    cachePath = process.env.MONITOR_CACHE_PATH ?? join(homedir(), '.tokenlens', 'usage-cache.json'),
  ) {
    this.sources = typeof sources === 'string' ? [{ harness: 'claude', root: sources }] : sources
    this.cachePath = cachePath
    this.archiveRoot = join(dirname(cachePath), 'favorites')
  }

  /** Claude Code's history folder, the one the privacy scope is named after. */
  get root(): string {
    return this.sources.find((source) => source.harness === 'claude')?.root ?? ''
  }

  start(log: FastifyBaseLogger): void {
    this.log = log
    this.watch()
  }

  /** Whether any harness history can be read; a folder created after start begins being watched here. */
  async check(): Promise<ClaudeStatus> {
    const statuses = await Promise.all(this.sources.map(checkSource))
    const root = this.sources.map((source) => source.root).join(' · ')
    const sessions = statuses.reduce((total, status) => total + (status.ok ? status.sessions : 0), 0)
    if (sessions) {
      this.watch()
      return { ok: true, root, sessions }
    }
    const [first] = statuses as Extract<ClaudeStatus, { ok: false }>[]
    if (statuses.length === 1) return first
    return { ...first, root, message: `Nenhuma sessão encontrada em ${root}. Converse ao menos uma vez com o Claude Code, o Codex ou o pi. Se algum grava em outro lugar, ajuste o caminho no .env.` }
  }

  // A folder is missing on a machine where its harness never ran; check() retries once it shows up.
  private watch(): void {
    let added = false
    for (const { root } of this.sources) {
      if (this.watchers.has(root)) continue
      let watcher: FSWatcher
      try {
        watcher = watch(root, { recursive: true }, (_event, name) => {
          if (name?.endsWith('.jsonl')) this.queue(join(root, name))
        })
      } catch {
        continue
      }
      // An unhandled 'error' (the folder deleted, say) would take the whole API down.
      watcher.on('error', (error) => {
        this.log?.warn({ root, error }, 'parou de acompanhar a pasta de sessões')
        watcher.close()
        this.watchers.delete(root)
      })
      this.watchers.set(root, watcher)
      added = true
    }
    // A \\wsl.localhost path is the usual case on Windows, where the agents run inside WSL.
    if (!this.pollTimer && (process.env.MONITOR_POLL_MS || this.sources.some(({ root }) => root.startsWith('\\\\')))) {
      this.poll()
      added = true
    }
    if (!added) return
    const startedAt = Date.now()
    void this.scan().then(() => this.log?.info({ sessions: this.sessions.size, ms: Date.now() - startedAt }, 'histórico de uso carregado'))
  }

  // One scan at a time, and a share so slow that a scan takes minutes gets the same wait before the next.
  private poll(previousMs = 0): void {
    this.pollTimer = setTimeout(() => {
      // Nobody is watching (the app is minimized, every page closed): no reason to re-read the share.
      if (!this.listeners.size) return this.poll()
      const startedAt = Date.now()
      void this.scan().finally(() => this.poll(Date.now() - startedAt))
    }, Math.max(POLL_EVERY_MS, previousMs))
  }

  async stop(): Promise<void> {
    for (const watcher of this.watchers.values()) watcher.close()
    clearTimeout(this.pollTimer)
    clearTimeout(this.timer)
    clearTimeout(this.saveTimer)
    await this.enqueue(() => this.save())
  }

  async scan(): Promise<void> {
    const paths: string[] = []
    for (const { root } of this.sources) {
      const names = await readdir(root, { recursive: true }).catch(() => [])
      // Oldest first, so a Codex subagent's parent is known before its own file is read.
      paths.push(...names.filter((name) => name.endsWith('.jsonl')).sort().map((name) => join(root, name)))
    }
    const changed = new Set<string>()
    return this.enqueue(async () => {
      if (!this.sessions.size) await this.load()
      // Reading a file the agent deleted since marks its session as gone.
      const listed = new Set(paths)
      for (const path of this.files.keys()) if (!listed.has(path) && !this.deleted.has(path)) paths.push(path)
      const first = !this.ready
      for (const path of paths) await this.read(path, changed)
      this.ready = true
      this.emit('snapshot', this.list())
      // On a polled root this is the only notice a session gets, and the open detail refreshes on it.
      if (!first) this.emitChanged(changed)
      if (first || changed.size) await this.save()
    })
  }

  /** Limits reading to these history folders; a wider scope reads what was skipped. */
  setScope(scope: string[] | null): void {
    if (JSON.stringify(scope) === JSON.stringify(this.scope)) return
    this.scope = scope
    if (this.ready) void this.scan()
  }

  /** Forgets every total and the cache file, then reads again only what the scope allows. */
  async reset(): Promise<void> {
    await this.enqueue(async () => {
      // Deleted transcripts cannot be read again, so their sessions would be lost for good.
      const kept = [...this.deleted].filter((path) => this.inScope(path))
      const files = kept.flatMap((path) => (this.files.has(path) ? [[path, this.files.get(path)!] as const] : []))
      const contexts = kept.flatMap((path) => (this.contexts.has(path) ? [[path, this.contexts.get(path)!] as const] : []))
      const sessions = [...this.gone].flatMap((id) => (kept.some((path) => this.mainOf(path) === id) ? [this.sessions.get(id)!] : []))
      this.sessions.clear()
      this.files.clear()
      this.contexts.clear()
      for (const [path, offset] of files) this.files.set(path, offset)
      for (const [path, context] of contexts) this.contexts.set(path, context)
      for (const session of sessions) this.sessions.set(session.id, session)
      await rm(this.cachePath, { force: true })
    })
    await this.scan()
  }

  unignore(project: string): void {
    this.ignored.delete(project)
  }

  /** The session counted only from `since` on, or undefined when nothing is left. */
  trim(session: SessionUsage, since: string): SessionUsage | undefined {
    const tracked = this.sessions.get(session.id)
    if (!tracked) return undefined
    const trimmed: SessionUsage = { ...session, turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, firstAt: session.lastAt }
    for (const seen of tracked.seen.values()) {
      if (seen.at < since) continue
      trimmed.turns += 1
      for (const kind of ['input', 'output', 'cacheRead', 'cacheWrite', 'cost'] as const) trimmed[kind] += seen[kind]
      if (seen.at < trimmed.firstAt) trimmed.firstAt = seen.at
    }
    return trimmed.turns ? trimmed : undefined
  }

  /** USD spent per hour (start of the UTC hour in ms) by these sessions' replies from `since` on. */
  spend(sessions: SessionUsage[], since: string): Map<number, number> {
    const hours = new Map<number, number>()
    for (const { id } of sessions)
      for (const seen of this.sessions.get(id)?.seen.values() ?? []) {
        if (!seen.cost || seen.at < since) continue
        const hour = Math.floor(Date.parse(seen.at) / HOUR_MS) * HOUR_MS
        hours.set(hour, (hours.get(hour) ?? 0) + seen.cost)
      }
    return hours
  }

  /** Hides the project from every listing and pushes the new list to open pages. */
  ignore(project: string): void {
    this.ignored.add(project)
    if (this.ready) this.emit('snapshot', this.list())
  }

  list(): SessionUsage[] {
    return [...this.sessions.values()]
      .filter((session) => this.visible(session))
      .sort((a, b) => b.lastAt.localeCompare(a.lastAt))
      .map((session) => this.public(session))
  }

  get(id: string): SessionUsage | undefined {
    const session = this.sessions.get(id)
    return session && this.visible(session) ? this.public(session) : undefined
  }

  private public({ seen: _seen, customTitle: _customTitle, ...session }: Tracked): SessionUsage {
    const lost = this.gone.has(session.id) && !this.archived.has(session.id)
    return { ...session, models: [...session.models], ...(lost ? { lost } : {}) }
  }

  private visible(session: Tracked): boolean {
    return session.turns > 0 && !(session.project && this.ignored.has(session.project))
  }

  /** The session's transcripts, from the favorites archive once the agent deleted them; no main when nothing is left. */
  transcripts(id: string): { harness: Harness; main: string | undefined; subagents: string[] } {
    const found = this.originals(id)
    if (!this.gone.has(id)) return found
    if (!this.archived.has(id) || !found.main) return { harness: found.harness, main: undefined, subagents: [] }
    return { harness: found.harness, main: this.archivedPath(id, found.main), subagents: found.subagents.map((path) => this.archivedPath(id, path)) }
  }

  /** Copies each favorite's transcripts out of the agent's reach and drops the copies no longer starred. */
  async keep(favorites: Set<string>): Promise<void> {
    const changed = new Set<string>()
    for (const id of this.archived) {
      if (favorites.has(id)) continue
      await rm(join(this.archiveRoot, id), { recursive: true, force: true })
      this.archived.delete(id)
      changed.add(id)
    }
    for (const id of favorites) {
      if (!SAFE_ID.test(id) || this.gone.has(id)) continue
      const { main, subagents } = this.originals(id)
      if (!main) continue
      for (const path of [main, ...subagents]) {
        const target = this.archivedPath(id, path)
        const size = (await stat(path).catch(() => undefined))?.size
        // A copy of the same size is up to date: transcripts only grow.
        if (size === undefined || size === (await stat(target).catch(() => undefined))?.size) continue
        await mkdir(dirname(target), { recursive: true })
        await copyFile(path, target)
        await copyFile(path.replace(/\.jsonl$/, '.meta.json'), target.replace(/\.jsonl$/, '.meta.json')).catch(() => undefined)
      }
      this.archived.add(id)
    }
    if (this.ready) this.emitChanged(new Set([...changed].filter((id) => this.gone.has(id))))
  }

  private archivedPath(id: string, path: string): string {
    return join(this.archiveRoot, id, relative(this.sourceOf(path)!.root, path))
  }

  private originals(id: string): { harness: Harness; main: string | undefined; subagents: string[] } {
    const harness = this.sessions.get(id)?.harness ?? 'claude'
    const paths = [...this.files.keys()].filter((path) => this.sourceOf(path)?.harness === harness)
    if (harness === 'claude')
      return {
        harness,
        main: paths.find((path) => basename(path) === `${id}.jsonl`),
        subagents: paths.filter((path) => path.includes(`${sep}${id}${sep}subagents${sep}`)),
      }
    // Codex subagents are threads of their own whose session_meta names the parent session.
    return {
      harness,
      main: paths.find((path) => fileUuid(path) === id),
      subagents: paths.filter((path) => fileUuid(path) !== id && this.contexts.get(path)?.session === id),
    }
  }

  subscribe(listener: Listener): () => void {
    // The page reconnects when it becomes visible again, and the paused poll read nothing meanwhile.
    if (!this.listeners.size && this.ready) void this.scan()
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private queue(path: string): void {
    this.pending.add(path)
    this.timer ??= setTimeout(() => {
      this.timer = undefined
      void this.enqueue(() => this.flush())
    }, DEBOUNCE_MS)
  }

  private async flush(): Promise<void> {
    const paths = [...this.pending]
    this.pending.clear()
    const changed = new Set<string>()
    for (const path of paths) await this.read(path, changed)
    if (!this.ready || !changed.size) return
    this.saveTimer ??= setTimeout(() => {
      this.saveTimer = undefined
      void this.enqueue(() => this.save())
    }, SAVE_EVERY_MS)
    this.emitChanged(changed)
  }

  private emitChanged(changed: Set<string>): void {
    if (!changed.size) return
    this.emit('update', [...changed].map((id) => this.sessions.get(id)!).filter((s) => this.visible(s)).map((s) => this.public(s)))
  }

  // A failed task is logged and dropped; letting it reject would skip every task queued after it.
  private enqueue(task: () => Promise<void>): Promise<void> {
    this.work = this.work.then(task).catch((error: unknown) => this.log?.error(error, 'falha ao processar o uso'))
    return this.work
  }

  /** Restores totals and read offsets, so a restart only reads what was written since. */
  private async load(): Promise<void> {
    for (const id of await readdir(this.archiveRoot).catch(() => [])) this.archived.add(id)
    const cache = await readFile(this.cachePath, 'utf8')
      .then((text) => JSON.parse(text) as Cache)
      .catch(() => undefined)
    if (cache?.version !== CACHE_VERSION || cache.roots !== this.roots()) return
    for (const [path, offset] of cache.files) this.files.set(path, offset)
    for (const [path, context] of cache.contexts) this.contexts.set(path, context)
    for (const { seen, ...session } of cache.sessions) this.sessions.set(session.id, { ...session, seen: new Map(seen) })
  }

  // Runs on the work chain: offsets and totals are captured together, never mid-read.
  private async save(): Promise<void> {
    const cache: Cache = {
      version: CACHE_VERSION,
      roots: this.roots(),
      files: [...this.files],
      contexts: [...this.contexts],
      sessions: [...this.sessions.values()].map((session) => ({ ...session, seen: [...session.seen] })),
    }
    // Per process: during a restart the old and the new API both save.
    const temporary = `${this.cachePath}.${process.pid}.tmp`
    await mkdir(dirname(this.cachePath), { recursive: true })
    await writeFile(temporary, JSON.stringify(cache))
    await rename(temporary, this.cachePath)
  }

  private emit(event: UsageEvent, sessions: SessionUsage[]): void {
    for (const listener of this.listeners) listener(event, sessions)
  }

  private roots(): string {
    return this.sources.map((source) => source.root).join('\n')
  }

  private sourceOf(path: string): Source | undefined {
    return this.sources.find((source) => path.startsWith(`${source.root}${sep}`))
  }

  // ponytail: only Claude Code names folders after the project; Codex and pi are read whole and `shows` hides them.
  private inScope(path: string): boolean {
    const source = this.sourceOf(path)
    if (!this.scope || source?.harness !== 'claude') return true
    const folder = relative(source.root, path).split(sep)[0]
    // A subfolder's history is named after it with a '-' suffix.
    return this.scope.some((allowed) => folder === allowed || folder.startsWith(`${allowed}-`))
  }

  private async read(path: string, changed: Set<string>): Promise<void> {
    const source = this.sourceOf(path)
    if (!source || !this.inScope(path)) return
    // Opening a file on a WSL share costs ~25x its stat, and a poll pass touches every file.
    const size = (await stat(path).catch(() => undefined))?.size
    this.mark(path, size === undefined, changed)
    if (size === undefined || size === this.files.get(path)) return
    const handle = await open(path, 'r').catch(() => undefined)
    if (!handle) return
    try {
      const { size } = await handle.stat()
      let offset = this.files.get(path) ?? 0
      // A shorter file was rewritten; message ids keep the re-read from double counting.
      if (size < offset) offset = 0
      // One reused buffer: a fresh one per chunk piles up faster than GC frees it.
      // `rest` bytes at its start are the line cut by the previous chunk.
      let buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK, size - offset))
      let rest = 0
      while (offset + rest < size) {
        if (rest === buffer.length) buffer = Buffer.concat([buffer, Buffer.allocUnsafe(READ_CHUNK)])
        const { bytesRead } = await handle.read(buffer, rest, Math.min(buffer.length, size - offset) - rest, offset + rest)
        if (!bytesRead) return
        const filled = rest + bytesRead
        // The unfinished last line stays unread until Claude Code writes its newline.
        const end = buffer.lastIndexOf(NEWLINE, filled - 1)
        if (end < 0) {
          rest = filled
          continue
        }
        offset += end + 1
        this.files.set(path, offset)
        this.scanLines(source.harness, path, buffer.subarray(0, end), changed)
        rest = filled - end - 1
        buffer.copy(buffer, 0, end + 1, filled)
      }
    } finally {
      await handle.close()
    }
  }

  private mark(path: string, deleted: boolean, changed: Set<string>): void {
    if (deleted === this.deleted.has(path)) return
    if (deleted) this.deleted.add(path)
    else this.deleted.delete(path)
    const id = this.mainOf(path)
    if (!id || !this.sessions.has(id)) return
    if (deleted) this.gone.add(id)
    else this.gone.delete(id)
    changed.add(id)
  }

  /** The session this file is the main transcript of; a subagent's file is not. */
  private mainOf(path: string): string | undefined {
    if (this.sourceOf(path)?.harness === 'claude') return basename(dirname(path)) === 'subagents' ? undefined : basename(path, '.jsonl')
    return this.contexts.get(path)?.subagent ? undefined : fileUuid(path)
  }

  /** Decodes only the lines that can carry usage, a title or the file's context. */
  private scanLines(harness: Harness, path: string, data: Buffer, changed: Set<string>): void {
    const needles = NEEDLES[harness]
    const hits = needles.map((needle) => data.indexOf(needle))
    for (;;) {
      const hit = Math.min(...hits.filter((index) => index >= 0))
      if (hit === Infinity) return
      const start = data.lastIndexOf(NEWLINE, hit) + 1
      const newline = data.indexOf(NEWLINE, hit)
      const end = newline < 0 ? data.length : newline
      this.ingest(harness, path, data.toString('utf8', start, end), changed)
      needles.forEach((needle, index) => {
        if (hits[index] >= 0 && hits[index] < end) hits[index] = data.indexOf(needle, end)
      })
    }
  }

  private ingest(harness: Harness, path: string, line: string, changed: Set<string>): void {
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      return
    }
    let context = this.contexts.get(path)
    if (harness !== 'claude' && !context) this.contexts.set(path, (context = {}))
    const parsed = harness === 'claude' ? parseClaude(entry as Line) : harness === 'codex' ? parseCodex(entry as CodexLine, path, context!) : parsePi(entry as PiLine, path, context!)
    if (!parsed) return
    const session = this.session(parsed.session, harness)
    if (parsed.cwd) session.project ??= parsed.cwd
    if (parsed.title && !(parsed.promptTitle && session.title)) {
      if (parsed.customTitle) Object.assign(session, { title: parsed.title, customTitle: true })
      else if (!session.customTitle) session.title = parsed.title
      changed.add(session.id)
    }
    const reply = parsed.reply
    if (!reply) return
    const previous = session.seen.get(reply.id)
    if (!previous) session.turns += 1
    for (const kind of Object.keys(reply.counts) as (keyof Counts)[]) session[kind] += reply.counts[kind] - (previous?.[kind] ?? 0)
    session.cost += reply.cost - (previous?.cost ?? 0)
    session.seen.set(reply.id, { ...reply.counts, cost: reply.cost, at: parsed.at ?? previous?.at ?? '' })
    if (reply.model && reply.model !== '<synthetic>' && !session.models.includes(reply.model)) session.models.push(reply.model)
    if (parsed.at) {
      if (!session.firstAt || parsed.at < session.firstAt) session.firstAt = parsed.at
      if (parsed.at > session.lastAt) session.lastAt = parsed.at
    }
    changed.add(session.id)
  }

  private session(id: string, harness: Harness): Tracked {
    let session = this.sessions.get(id)
    if (!session) {
      session = { id, harness, title: null, project: null, models: [], turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, firstAt: '', lastAt: '', seen: new Map(), customTitle: false }
      this.sessions.set(id, session)
    }
    return session
  }
}

async function checkSource({ harness, root }: Source): Promise<ClaudeStatus> {
  const name = { claude: 'Claude Code', codex: 'Codex', pi: 'pi' }[harness]
  let names: string[]
  try {
    names = await readdir(root, { recursive: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, root, code: 'not-found', message: `Não encontramos a pasta de sessões do ${name} em ${root}. Instale o Claude Code, o Codex ou o pi e converse com ele ao menos uma vez. Se ele grava em outro lugar, ajuste o caminho no .env.` }
    if (code === 'EACCES' || code === 'EPERM') return { ok: false, root, code: 'no-access', message: `Sem permissão para ler ${root}. Rode o monitor com o mesmo usuário do sistema que usa o ${name}.` }
    return { ok: false, root, code: 'unreadable', message: `Não foi possível ler ${root} (${code ?? String(error)}).` }
  }
  const sessions = names.filter((file) => file.endsWith('.jsonl')).length
  if (!sessions) return { ok: false, root, code: 'empty', message: `A pasta ${root} existe, mas ainda não tem nenhuma sessão. Abra o ${name}, envie uma mensagem e tente de novo.` }
  return { ok: true, root, sessions }
}

function parseClaude(entry: Line): Parsed | undefined {
  if (!entry.sessionId) return undefined
  const base = { session: entry.sessionId }
  if (entry.customTitle) return { ...base, title: entry.customTitle, customTitle: true }
  if (entry.aiTitle) return { ...base, title: entry.aiTitle }
  const message = entry.message
  const usage = message?.usage
  if (entry.type !== 'assistant' || !usage || !message?.id) return undefined
  // Claude Code writes one line per content block; only the last carries the final output_tokens.
  const counts: Counts = {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
  }
  return { ...base, at: entry.timestamp, cwd: entry.cwd, reply: { id: message.id, model: message.model, counts, cost: message.model ? sum(costOf(message.model, usage)) : 0 } }
}

type CodexLine = {
  timestamp?: string
  type?: string
  payload?: {
    type?: string
    id?: string
    session_id?: string
    cwd?: string
    model?: string
    thread_source?: string
    info?: { total_token_usage?: CodexTokens; last_token_usage?: CodexTokens } | null
    item?: { type?: string; content?: { text?: string }[] }
  }
}

function parseCodex(entry: CodexLine, path: string, context: FileContext): Parsed | undefined {
  const payload = entry.payload
  const thread = fileUuid(path)
  if (!payload || !thread) return undefined
  // A subagent's file repeats its parent's session_meta after its own; the first one wins.
  if (entry.type === 'session_meta') {
    if (context.session) return undefined
    Object.assign(context, { session: payload.session_id ?? payload.id ?? thread, cwd: payload.cwd, subagent: payload.thread_source === 'subagent' })
    return { session: context.session!, cwd: context.cwd }
  }
  const base = { session: context.session ?? thread, at: entry.timestamp, cwd: context.cwd }
  if (entry.type === 'turn_context') {
    context.model = payload.model ?? context.model
    context.cwd ??= payload.cwd
    return undefined
  }
  if (payload.type === 'item_completed' && payload.item?.type === 'UserMessage') {
    const text = payload.item.content?.map((part) => part.text ?? '').join(' ').trim()
    // Codex keeps no title in the transcript; the first prompt stands in, as its own picker shows.
    if (context.subagent || !text) return undefined
    return { ...base, title: text.slice(0, TITLE_LIMIT), promptTitle: true }
  }
  const info = payload.info
  if (payload.type !== 'token_count' || !info?.last_token_usage) return undefined
  // Codex may repeat the same count; the running total is unique per reply within a thread.
  const counts = codexCounts(info.last_token_usage)
  const priced = { input_tokens: counts.input, output_tokens: counts.output, cache_read_input_tokens: counts.cacheRead, cache_creation_input_tokens: counts.cacheWrite }
  return { ...base, reply: { id: `${thread}:${info.total_token_usage?.total_tokens ?? entry.timestamp}`, model: context.model, counts, cost: context.model ? sum(costOf(context.model, priced)) : 0 } }
}

type PiLine = {
  type?: string
  id?: string
  timestamp?: string
  cwd?: string
  name?: string
  message?: {
    role?: string
    model?: string
    content?: string | { type?: string; text?: string }[]
    usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: Partial<Costs> }
  }
}

/** Total of a reply's costs; null (no known price) counts as zero. */
const sum = (costs: Partial<Costs> | null | undefined) =>
  (costs?.input ?? 0) + (costs?.output ?? 0) + (costs?.cacheRead ?? 0) + (costs?.cacheWrite ?? 0)

function parsePi(entry: PiLine, path: string, context: FileContext): Parsed | undefined {
  const session = fileUuid(path)
  if (!session) return undefined
  if (entry.type === 'session') {
    context.cwd = entry.cwd
    return { session, cwd: entry.cwd }
  }
  const base = { session, at: entry.timestamp, cwd: context.cwd }
  if (entry.type === 'session_info' && entry.name) return { ...base, title: entry.name, customTitle: true }
  const message = entry.message
  if (entry.type !== 'message' || !message) return undefined
  if (message.role === 'user') {
    const content = message.content
    const text = (typeof content === 'string' ? content : content?.map((part) => part.text ?? '').join(' '))?.trim()
    return text ? { ...base, title: text.slice(0, TITLE_LIMIT), promptTitle: true } : undefined
  }
  const usage = message.usage
  if (message.role !== 'assistant' || !usage || !entry.id) return undefined
  // pi prices each reply itself, so its cost is taken as is.
  return { ...base, reply: { id: entry.id, model: message.model, counts: { input: usage.input ?? 0, output: usage.output ?? 0, cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0 }, cost: sum(usage.cost) } }
}

/** One project's sessions summed as if they were a single session, keyed by the project path. */
function projectUsage(project: string, sessions: SessionUsage[]): SessionUsage {
  const total: SessionUsage = { id: project, harness: sessions[0].harness, title: basename(project), project, models: [], turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, firstAt: sessions[0].firstAt, lastAt: sessions[0].lastAt }
  for (const session of sessions) {
    for (const kind of ['turns', 'input', 'output', 'cacheRead', 'cacheWrite', 'cost'] as const) total[kind] += session[kind]
    for (const model of session.models) if (!total.models.includes(model)) total.models.push(model)
    if (session.firstAt < total.firstAt) total.firstAt = session.firstAt
    if (session.lastAt > total.lastAt) total.lastAt = session.lastAt
  }
  return total
}

export type UsageRoutes = {
  /** Resends a user's list after their privacy changes. */
  resend: (userId: string) => void
  sessionDetail: (id: string, userId: string) => Promise<(SessionDetail & { session: SessionUsage }) | null>
  projectDetail: (path: string, userId: string) => Promise<(SessionDetail & { session: SessionUsage }) | null>
  /** Saves the settled sessions' summaries and the favorites' transcripts; runs every minute on its own. */
  persist: () => Promise<void>
}

const readers = { claude: readSessionDetail, codex: readCodexDetail, pi: readPiDetail }
// A running session changes every reply; it is summarized once it settles.
const SUMMARY_IDLE_MS = 10 * 60_000

// /clear opens a new session file while the old one gets its last line: ~0.1 s apart in practice.
const CLEAR_GAP_MS = 2_000

/** When the session was opened by /clear: the time of its first real prompt, if that prompt is /clear. */
async function clearedAt(path: string): Promise<number | undefined> {
  const handle = await open(path).catch(() => undefined)
  if (!handle) return undefined
  try {
    const head = Buffer.alloc(16 * 1024)
    const { bytesRead } = await handle.read(head, 0, head.length, 0)
    for (const line of head.toString('utf8', 0, bytesRead).split('\n')) {
      let entry: { type?: string; isMeta?: boolean; timestamp?: string; message?: { content?: unknown } }
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      if (entry.type !== 'user' || entry.isMeta) continue
      const content = entry.message?.content
      if (typeof content !== 'string' || !content.startsWith('<command-name>/clear</command-name>')) return undefined
      const at = Date.parse(entry.timestamp ?? '')
      return Number.isNaN(at) ? undefined : at
    }
    return undefined
  } finally {
    await handle.close()
  }
}

/** The sessions of the same folder that a /clear ended into this one, and that this one's /clear opened. */
async function clearNeighbors(main: string): Promise<NonNullable<SessionDetail['clear']>> {
  const folder = dirname(main)
  const names = (await readdir(folder).catch(() => [])).filter((name) => name.endsWith('.jsonl') && join(folder, name) !== main)
  const others = await Promise.all(names.map(async (name) => ({ path: join(folder, name), mtime: (await stat(join(folder, name)).catch(() => undefined))?.mtimeMs ?? 0 })))
  const closest = (candidates: { path: string; gap: number }[]) =>
    candidates.filter((candidate) => candidate.gap <= CLEAR_GAP_MS).sort((a, b) => a.gap - b.gap)[0]?.path
  const idOf = (path?: string) => path && basename(path, '.jsonl')
  const start = await clearedAt(main)
  // The old session's file was last written as /clear closed it.
  const previous = start === undefined ? undefined : closest(others.map(({ path, mtime }) => ({ path, gap: Math.abs(mtime - start) })))
  const end = (await stat(main)).mtimeMs
  const later = others.filter((other) => other.mtime >= end - CLEAR_GAP_MS)
  const next = closest(
    await Promise.all(later.map(async ({ path }) => ({ path, gap: Math.abs(((await clearedAt(path)) ?? -Infinity) - end) }))),
  )
  const iso = (at: number) => new Date(at).toISOString()
  return { previous: idOf(previous), next: idOf(next), startedAt: start === undefined ? undefined : iso(start), endedAt: next ? iso(end) : undefined }
}

/** A subagent's descendants, read with it so its totals include theirs, and the agent that started it. */
async function subtree(agent: string, paths: string[]) {
  const metas = await Promise.all(paths.map(async (path) => ({ path, id: agentIdOf(path), ...(await readAgentMeta(path)) })))
  const subagents: string[] = []
  const queue = [agent]
  for (const parent of queue)
    for (const meta of metas)
      if (meta.parentAgentId === parent && !subagents.includes(meta.path)) {
        subagents.push(meta.path)
        queue.push(meta.id)
      }
  const parentId = metas.find((meta) => meta.id === agent)?.parentAgentId
  const parent = metas.find((meta) => meta.id === parentId)
  const startedBy = parent
    ? { id: parent.id, name: parent.description || parent.agentType || 'subagente' }
    : { id: 'main', name: 'Conversa principal' }
  return { subagents, parent: startedBy }
}

/** Registers the usage routes and returns the readers the share sync reuses. */
export function registerUsageRoutes(app: FastifyInstance, db: Database, usage: UsageTracker): UsageRoutes {
  const requireUser = authenticated(db)
  const notFound = { error: { message: 'Sessão não encontrada.' } }
  const expired = { error: { message: 'Sua sessão expirou. Entre novamente.' } }
  const setupPending = { error: { message: 'Conclua a configuração inicial para ver o uso.' } }
  for (const { path } of db.prepare('SELECT path FROM ignored_projects').all() as { path: string }[]) usage.ignore(path)
  // What the account may see, counted from its own start date when it cleared the history.
  const view = (privacy: Privacy, sessions: SessionUsage[]) =>
    sessions.flatMap((session) => {
      if (!shows(privacy, session)) return []
      const trimmed = privacy.since ? usage.trim(session, privacy.since) : session
      return trimmed ? [trimmed] : []
    })
  const narrowed = (privacy: Privacy, from?: string): Privacy =>
    from && (!privacy.since || from > privacy.since) ? { ...privacy, since: from } : privacy
  // Each stream sends only what its account may see; a paused account gets no new data.
  const streams = new Map<FastifyReply['raw'], { userId: string; push: (event: UsageEvent, sessions: SessionUsage[], force?: boolean) => void }>()
  // app.close() waits for open connections, and an SSE stream never ends on its own.
  app.addHook('preClose', async () => {
    for (const stream of streams.keys()) stream.end()
  })
  app.get('/v1/usage/stream', async (request, reply) => {
    const user = requireUser(request)
    if (!user) return reply.code(401).send(expired)
    if (!user.onboarded) return reply.code(403).send(setupPending)
    // Picks up accounts created since the last change, so a new one is read too.
    usage.setScope(readScope(db))
    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    const send = (event: UsageEvent | 'loading', data: unknown) => raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    const push = (event: UsageEvent, sessions: SessionUsage[], force = false) => {
      const privacy = readPrivacy(db, user.id)
      if (privacy.paused && !force) return
      send(event, view(privacy, sessions))
    }
    streams.set(raw, { userId: user.id, push })
    if (usage.ready) push('snapshot', usage.list(), true)
    else send('loading', null)
    const unsubscribe = usage.subscribe((event, sessions) => push(event, sessions))
    // Keeps idle proxies (the Vite dev proxy included) from closing the stream.
    const ping = setInterval(() => raw.write(': ping\n\n'), 25_000)
    request.raw.on('close', () => {
      streams.delete(raw)
      unsubscribe()
      clearInterval(ping)
    })
  })
  // Re-reading a long session costs ~1 s per live update or chat page, so the open one is kept.
  // ponytail: one entry bounds RAM; two users on different sessions take turns re-reading.
  const agentId = z.string().regex(/^\w+$/).optional()
  let lastDetail: { id: string; version: string; detail: SessionDetail } | undefined
  // With `agent`, one subagent's own transcript is read as if it were the session.
  // `from` narrows the account's own start date further, e.g. to a project page's period.
  const load = async (id: string, userId: string, agent?: string, from?: string) => {
    const tracked = usage.get(id)
    let { harness, main, subagents } = usage.transcripts(id)
    const all = subagents
    if (agent) {
      main = subagents.find((path) => agentIdOf(path) === agent)
      subagents = []
    }
    const privacy = narrowed(readPrivacy(db, userId), from)
    let [session] = tracked ? view(privacy, [tracked]) : []
    if (!session) return null
    const size = main ? (await stat(main).catch(() => undefined))?.size : undefined
    if (size === undefined) return agent ? null : stored(tracked!, session, privacy)
    // The size catches prompts, which change no totals; access was already checked by `view`.
    const version = `${session.lastAt}${session.turns}${privacy.since}${size}`
    const key = agent ? `${id}/${agent}` : id
    if (lastDetail?.id !== key || lastDetail.version !== version) {
      const read = readers[harness]
      const tree = agent ? await subtree(agent, all) : undefined
      const detail = await read(main!, tree?.subagents ?? subagents, privacy.since ?? undefined)
      const clear = harness === 'claude' && !agent ? await clearNeighbors(main!) : undefined
      lastDetail = { id: key, version, detail: tree ? { ...detail, startedBy: tree.parent } : { ...detail, clear } }
    }
    const { detail } = lastDetail
    if (agent) {
      // The summary reads `session`, so it takes the numbers and span of the subagent and its descendants.
      const { description, type } = detail.agents[0]!
      const totals = { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
      for (const row of detail.agents) for (const kind of Object.keys(totals) as (keyof typeof totals)[]) totals[kind] += row[kind]
      const models = [...new Set(detail.agents.flatMap((row) => row.models))]
      const at = detail.timeline.map((point) => point.at).sort()
      const span = { firstAt: at[0] ?? session.firstAt, lastAt: at.at(-1) ?? session.lastAt }
      session = { ...session, ...span, ...totals, title: description || type, models }
    }
    // A linked session hidden from this account is left out, like it is from the list.
    const shown = (other?: string) => {
      const tracked = other ? usage.get(other) : undefined
      return tracked && view(privacy, [tracked]).length ? other : undefined
    }
    const clear = detail.clear && { ...detail.clear, previous: shown(detail.clear.previous), next: shown(detail.clear.next) }
    if (!privacy.hideChat) return { session, ...detail, clear }
    return { session, ...detail, clear, messages: [], timeline: detail.timeline.map((point) => ({ ...point, prompt: '' })) }
  }

  // What was saved before the agent deleted the transcript: every number, no chat.
  const stored = (tracked: SessionUsage, session: SessionUsage, privacy: Privacy) => {
    const row = db.prepare('SELECT detail FROM session_summaries WHERE session_id = ?').get(tracked.id) as { detail: string } | undefined
    // ponytail: the summary covers the whole session, so a start date inside it leaves the session out.
    if (!row || (privacy.since && tracked.firstAt < privacy.since)) return null
    return { session, ...(JSON.parse(row.detail) as SessionDetail), summary: true }
  }

  // Claude Code deletes old transcripts: each settled session's numbers and each favorite's files are kept here.
  let persistTimer: NodeJS.Timeout | undefined
  const persist = async () => {
    const favorites = db.prepare('SELECT DISTINCT session_id FROM favorites').all() as { session_id: string }[]
    await usage.keep(new Set(favorites.map((row) => row.session_id)))
    const versions = new Map((db.prepare('SELECT session_id, version FROM session_summaries').all() as { session_id: string; version: string }[]).map((row) => [row.session_id, row.version]))
    const save = db.prepare('INSERT INTO session_summaries (session_id, version, detail) VALUES (?, ?, ?) ON CONFLICT (session_id) DO UPDATE SET version = excluded.version, detail = excluded.detail')
    for (const session of usage.list()) {
      const version = `${session.lastAt}${session.turns}`
      if (versions.get(session.id) === version || Date.now() - Date.parse(session.lastAt) < SUMMARY_IDLE_MS) continue
      const { harness, main, subagents } = usage.transcripts(session.id)
      if (!main) continue
      const detail = await readers[harness](main, subagents)
      const summary: SessionDetail = { ...detail, messages: [], clear: undefined, timeline: detail.timeline.map((point) => ({ ...point, prompt: '' })) }
      save.run(session.id, version, JSON.stringify(summary))
    }
  }
  const schedule = () => {
    persistTimer = setTimeout(() => {
      if (!usage.ready) return schedule()
      void persist().catch((error: unknown) => app.log.error(error, 'falha ao guardar o resumo das sessões')).finally(schedule)
    }, Number(process.env.MONITOR_PERSIST_MS ?? 60_000))
  }
  schedule()
  app.addHook('onClose', async () => clearTimeout(persistTimer))

  // The poll pauses with no page open and a WSL share answers slowly: this is the way out of a stale list.
  app.post('/v1/usage/refresh', async (request, reply) => {
    const user = requireUser(request)
    if (!user) return reply.code(401).send(expired)
    if (!user.onboarded) return reply.code(403).send(setupPending)
    // The scan pushes a snapshot to every open stream, this one included.
    await usage.scan()
    return { ok: true }
  })

  app.get('/v1/claude/status', async (request, reply) => {
    if (!requireUser(request)) return reply.code(401).send(expired)
    return usage.check()
  })

  // Sends the chat tail only: from `since` when the page already holds older lines, else the last page.
  app.get<{ Params: { id: string } }>('/v1/usage/sessions/:id', async (request, reply) => {
    const user = requireUser(request)
    if (!user) return reply.code(401).send(expired)
    if (!user.onboarded) return reply.code(403).send(setupPending)
    const { since, agent } = z.object({ since: z.coerce.number().int().min(0).optional(), agent: agentId }).parse(request.query)
    const detail = await load(request.params.id, user.id, agent)
    if (!detail) return reply.code(404).send(notFound)
    const messageStart = Math.min(since ?? Math.max(0, detail.messages.length - CHAT_PAGE), detail.messages.length)
    return { ...detail, messageStart, messages: detail.messages.slice(messageStart) }
  })

  // Reading a big project takes seconds, so each session is re-read only after it changes.
  const projectDetails = new Map<string, { version: string; detail: SessionDetail }>()
  const loadProject = async (path: string, userId: string, from?: string) => {
    const privacy = narrowed(readPrivacy(db, userId), from)
    const sessions = view(privacy, usage.list()).filter((session) => session.project === path)
    const details: SessionDetail[] = []
    for (const session of sessions) {
      // The chat is dropped anyway; the version keeps hidden prompts from being served from cache.
      const version = `${session.lastAt}${session.turns}${privacy.hideChat}${privacy.since}`
      let cached = projectDetails.get(session.id)
      if (cached?.version !== version) {
        const detail = await load(session.id, userId, undefined, from)
        if (!detail) continue
        projectDetails.set(session.id, (cached = { version, detail: { ...detail, messages: [] } }))
      }
      details.push(cached.detail)
    }
    if (!details.length) return null
    return { session: projectUsage(path, sessions), messageStart: 0, ...mergeDetails(details) }
  }
  // Hourly buckets let the page group by its own local hours and days.
  app.get('/v1/usage/spend', async (request, reply) => {
    const user = requireUser(request)
    if (!user) return reply.code(401).send(expired)
    if (!user.onboarded) return reply.code(403).send(setupPending)
    const { from } = z.object({ from: z.iso.datetime() }).parse(request.query)
    const privacy = narrowed(readPrivacy(db, user.id), from)
    const sessions = view(privacy, usage.list())
    return { hours: [...usage.spend(sessions, privacy.since ?? from)].sort((a, b) => a[0] - b[0]) }
  })
  // The path goes in the query string: it has slashes and is the project's only key.
  app.get('/v1/usage/projects', async (request, reply) => {
    const user = requireUser(request)
    if (!user) return reply.code(401).send(expired)
    if (!user.onboarded) return reply.code(403).send(setupPending)
    const { path, from } = z.object({ path: z.string().min(1), from: z.string().datetime().optional() }).parse(request.query)
    const detail = await loadProject(path, user.id, from)
    if (!detail) return reply.code(404).send({ error: { message: 'Projeto não encontrado.' } })
    return detail
  })

  app.delete('/v1/usage/projects', async (request, reply) => {
    const user = requireUser(request)
    if (!user) return reply.code(401).send(expired)
    if (!user.onboarded) return reply.code(403).send(setupPending)
    const { path } = z.object({ path: z.string().min(1).max(4096) }).parse(request.query)
    db.prepare('INSERT OR IGNORE INTO ignored_projects (path, created_at) VALUES (?, ?)').run(path, new Date().toISOString())
    usage.ignore(path)
    return { ok: true }
  })

  app.get<{ Params: { id: string } }>('/v1/usage/sessions/:id/messages', async (request, reply) => {
    const user = requireUser(request)
    if (!user) return reply.code(401).send(expired)
    if (!user.onboarded) return reply.code(403).send(setupPending)
    const { before, agent } = z.object({ before: z.coerce.number().int().min(0), agent: agentId }).parse(request.query)
    const detail = await load(request.params.id, user.id, agent)
    if (!detail) return reply.code(404).send(notFound)
    const end = Math.min(before, detail.messages.length)
    const start = Math.max(0, end - CHAT_PAGE)
    return { start, messages: detail.messages.slice(start, end) }
  })

  return {
    resend: (userId) => {
      for (const stream of streams.values()) if (stream.userId === userId) stream.push('snapshot', usage.list(), true)
    },
    sessionDetail: load,
    projectDetail: loadProject,
    persist,
  }
}
