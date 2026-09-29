import { readFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { costOf, type Costs, type Usage } from './pricing.js'

export type TokenTotals = { turns: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }
export type Count = { name: string; count: number }
export type HookRun = { event: string; command: string; runs: number; failures: number; ms: number }
export type ChatMessage = { role: 'user' | 'assistant'; at: string; text: string; tools: string[] }

export type SessionDetail = {
  // What /usage showed when the session ended; null while it runs, since some API calls never reach the transcript.
  reportedCost: number | null
  costs: Costs
  // Time between the end of a turn and the next message, when Claude sat waiting for the user.
  // Spans where a subagent was still running do not count.
  idleMs: number
  byModel: (TokenTotals & { model: string })[]
  // `parent` is who started a subagent: 'main' for the user's conversation, else another subagent's id.
  agents: (TokenTotals & { id: string; type: string; description: string; models: string[]; parent?: string })[]
  // Models with no known price; their tokens are left out of every cost.
  unpriced: string[]
  tools: Count[]
  mcp: Count[]
  skills: Count[]
  commands: Count[]
  hooks: HookRun[]
  messages: ChatMessage[]
  // Each priced reply, main and subagents, in time order.
  timeline: CostPoint[]
  // Each /compact (trigger 'manual') or automatic compaction of the main agent's context.
  compactions?: { at: string; trigger: string; preTokens: number; postTokens: number }[]
  // Only on a subagent's own detail: who started it, where `id` 'main' is the session.
  startedBy?: { id: string; name: string }
  // The likely sessions on either side of a /clear, which starts a new session id, and when each /clear ran.
  clear?: { previous?: string; next?: string; startedAt?: string; endedAt?: string }
  // Read from the saved summary: the agent deleted the transcript, and the chat went with it.
  summary?: boolean
}

export type AgentMeta = { agentType?: string; description?: string; parentAgentId?: string }

export const agentIdOf = (path: string) => basename(path, '.jsonl').replace(/^agent-/, '')

/** What Claude Code writes next to a subagent's transcript: its type, task and the agent that started it. */
export const readAgentMeta = (path: string): Promise<AgentMeta> =>
  readFile(path.replace(/\.jsonl$/, '.meta.json'), 'utf8')
    .then((json) => JSON.parse(json) as AgentMeta)
    .catch(() => ({}))

export type CostPoint = {
  at: string
  cost: number
  agentId: string
  agent: string
  model: string
  tools: string[]
  // The user message, or the subagent's task, that led to this reply.
  prompt: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

type Block = { type?: string; text?: string; name?: string; input?: { skill?: string } }
type Entry = {
  type?: string
  subtype?: string
  isMeta?: boolean
  isSidechain?: boolean
  origin?: { name?: string; body?: string }
  timestamp?: string
  durationMs?: number
  totalCostUSD?: number
  hookInfos?: { command?: string; durationMs?: number }[]
  compactMetadata?: { trigger?: string; preTokens?: number; postTokens?: number }
  attachment?: { type?: string; hookEvent?: string; command?: string; durationMs?: number; blockingError?: { command?: string } }
  message?: {
    id?: string
    model?: string
    content?: string | Block[]
    usage?: Usage
  }
}

const PROMPT_LIMIT = 140
const FAILED_HOOKS = new Set(['hook_cancelled', 'hook_non_blocking_error', 'hook_blocking_error'])
export const emptyTotals = (): TokenTotals => ({ turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 })
export const sorted = (counts: Map<string, number>): Count[] =>
  [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
type Span = [start: number, end: number]

/** Total length of `spans` left uncovered by `busy`. */
function uncovered(spans: Span[], busy: Span[]): number {
  const merged: Span[] = []
  for (const [start, end] of [...busy].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1)
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  let total = 0
  for (const [start, end] of spans) {
    total += end - start
    for (const [from, to] of merged) total -= Math.max(0, Math.min(end, to) - Math.max(start, from))
  }
  return total
}

export const bump = (counts: Map<string, number>, name: string) => counts.set(name, (counts.get(name) ?? 0) + 1)

/** Turns a slash command line into `/name args`; returns null for any other user text. */
function slashCommand(text: string): string | null {
  const name = /<command-name>(.*?)<\/command-name>/s.exec(text)?.[1]
  if (!name) return null
  const args = /<command-args>(.*?)<\/command-args>/s.exec(text)?.[1]?.trim()
  return args ? `${name} ${args}` : name
}

function metaText(entry: Entry): string {
  const content = entry.message?.content
  if (typeof content === 'string') return content
  return content?.find((block) => block.type === 'text')?.text ?? ''
}

function userText(entry: Entry): string | null {
  const content = entry.message?.content
  // Prompts sent by another Claude session arrive as meta lines that keep the original text.
  if (entry.origin?.body) return `[${entry.origin.name ?? 'outra sessão'}] ${entry.origin.body}`
  if (entry.isMeta || !content) return null
  if (typeof content === 'string') {
    if (content.startsWith('<local-command')) return null
    return slashCommand(content) ?? content
  }
  const parts = content.flatMap((block) => (block.type === 'text' ? [block.text ?? ''] : block.type === 'image' ? ['[imagem]'] : []))
  return parts.length ? parts.join('\n') : null
}

/** Reads a session's transcripts from `since` on; `main` is the session file, the rest are its subagents. */
export async function readSessionDetail(main: string, subagents: string[], since?: string): Promise<SessionDetail> {
  const from = since ? Date.parse(since) : -Infinity
  // A subagent opened on its own is all sidechain lines, and those lines are its chat.
  const agentView = basename(dirname(main)) === 'subagents'
  // Its children name it as parent, and here it takes the main agent's place.
  const root = agentView ? agentIdOf(main) : 'main'
  const detail: SessionDetail = { reportedCost: null, costs: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, idleMs: 0, byModel: [], agents: [], unpriced: [], tools: [], mcp: [], skills: [], commands: [], hooks: [], messages: [], timeline: [], compactions: [] }
  const unpriced = new Set<string>()
  const byModel = new Map<string, TokenTotals>()
  const tools = new Map<string, number>()
  const mcp = new Map<string, number>()
  const skills = new Map<string, number>()
  const commands = new Map<string, number>()
  const hooks = new Map<string, HookRun>()
  const seen = new Set<string>()
  let lastReply: string | undefined
  let lastPrompt = ''
  // A slash command is a skill when Claude Code follows it with the skill's body.
  let lastCommand: string | undefined
  let idleSince: number | undefined
  let lastAt = 0
  const idle: Span[] = []
  const busy: Span[] = []

  const hook = (event: string, command: string) => {
    const key = `${event}\n${command}`
    let run = hooks.get(key)
    if (!run) hooks.set(key, (run = { event, command, runs: 0, failures: 0, ms: 0 }))
    return run
  }

  for (const path of [main, ...subagents]) {
    const isMain = path === main
    const text = await readFile(path, 'utf8').catch(() => '')
    const totals = emptyTotals()
    const models = new Set<string>()
    // Only a reply's last line carries its final output_tokens, so the last one wins.
    const replies = new Map<string, { model: string | undefined; usage: Usage; at: string; prompt: string; tools: string[] }>()
    let first = Infinity
    let last = -Infinity
    for (const line of text.split('\n')) {
      let entry: Entry
      try {
        entry = JSON.parse(line) as Entry
      } catch {
        continue
      }
      const at = entry.timestamp ? Date.parse(entry.timestamp) : NaN
      if (at < from) continue
      if (!Number.isNaN(at)) {
        lastAt = Math.max(lastAt, at)
        first = Math.min(first, at)
        last = Math.max(last, at)
      }
      if (isMain && idleSince !== undefined && !Number.isNaN(at) && (entry.type === 'user' || entry.type === 'assistant')) {
        idle.push([idleSince, Math.max(idleSince, at)])
        idleSince = undefined
      }
      const attachment = entry.attachment
      if (attachment?.hookEvent) {
        const run = hook(attachment.hookEvent, attachment.command ?? attachment.blockingError?.command ?? '')
        run.ms += attachment.durationMs ?? 0
        // Successful Stop hooks only show up in stop_hook_summary, which already counts the run.
        if (attachment.type === 'hook_success' || attachment.hookEvent !== 'Stop') run.runs += 1
        if (FAILED_HOOKS.has(attachment.type ?? '')) run.failures += 1
        continue
      }
      if (entry.subtype === 'stop_hook_summary') {
        for (const info of entry.hookInfos ?? []) {
          const run = hook('Stop', info.command ?? '')
          run.runs += 1
          run.ms += info.durationMs ?? 0
        }
        continue
      }
      if (entry.subtype === 'compact_boundary' && isMain) {
        const { trigger = 'auto', preTokens = 0, postTokens = 0 } = entry.compactMetadata ?? {}
        detail.compactions!.push({ at: entry.timestamp ?? '', trigger, preTokens, postTokens })
        continue
      }
      if (entry.type === 'cost-state' && isMain) {
        detail.reportedCost = entry.totalCostUSD ?? null
        continue
      }
      if (entry.subtype === 'turn_duration' && isMain) {
        if (!Number.isNaN(at)) idleSince = at
        continue
      }

      if (entry.type === 'user' && isMain && (agentView || !entry.isSidechain)) {
        const content = userText(entry)
        if (entry.isMeta && lastCommand && metaText(entry).startsWith('Base directory for this skill')) {
          bump(skills, lastCommand.slice(1))
          lastCommand = undefined
        }
        if (!content) continue
        const command = typeof entry.message?.content === 'string' ? slashCommand(entry.message.content) : null
        lastCommand = command?.split(' ')[0]
        if (lastCommand) bump(commands, lastCommand)
        detail.messages.push({ role: 'user', at: entry.timestamp ?? '', text: content, tools: [] })
        lastPrompt = content.slice(0, PROMPT_LIMIT)
        continue
      }
      if (entry.type !== 'assistant' || !entry.message) continue
      lastCommand = undefined
      // A reply after the saved state means the session was resumed; that state is stale.
      if (isMain) detail.reportedCost = null

      const message = entry.message
      const blocks = Array.isArray(message.content) ? message.content : []
      const names: string[] = []
      for (const block of blocks) {
        if (block.type !== 'tool_use' || !block.name) continue
        names.push(block.name)
        if (block.name.startsWith('mcp__')) bump(mcp, block.name.slice(5).replace('__', ' › '))
        else bump(tools, block.name)
        if (block.name === 'Skill' && block.input?.skill) bump(skills, block.input.skill)
      }
      const said = blocks.flatMap((block) => (block.type === 'text' && block.text ? [block.text] : []))
      if (isMain && (agentView || !entry.isSidechain) && (said.length || names.length)) {
        const last = detail.messages.at(-1)
        // Claude Code writes one line per content block; blocks of the same reply join one message.
        if (last?.role === 'assistant' && message.id && message.id === lastReply) {
          last.text = [last.text, ...said].filter(Boolean).join('\n\n')
          last.tools.push(...names)
        } else {
          detail.messages.push({ role: 'assistant', at: entry.timestamp ?? '', text: said.join('\n\n'), tools: names })
        }
        lastReply = message.id
      }

      if (message.usage && message.id && !seen.has(message.id)) {
        const tools = [...(replies.get(message.id)?.tools ?? []), ...names]
        replies.set(message.id, { model: message.model, usage: message.usage, at: entry.timestamp ?? '', prompt: lastPrompt, tools })
      }
    }
    const meta: AgentMeta = isMain && !agentView ? { agentType: 'principal', description: 'Conversa principal' } : await readAgentMeta(path)
    const agentId = isMain ? 'main' : agentIdOf(path)
    const agent = isMain ? 'principal' : [meta.agentType, meta.description].filter(Boolean).join(': ') || 'subagente'
    for (const [id, { model: name, usage, at, prompt, tools }] of replies) {
      seen.add(id)
      const model = name && name !== '<synthetic>' ? name : null
      if (model) models.add(model)
      const costs = model ? costOf(model, usage) : null
      if (model && !costs) unpriced.add(model)
      if (costs) for (const kind of Object.keys(costs) as (keyof Costs)[]) detail.costs[kind] += costs[kind]
      const cost = costs ? costs.input + costs.output + costs.cacheRead + costs.cacheWrite : 0
      if (cost && at)
        detail.timeline.push({
          at,
          cost,
          agentId,
          agent,
          model: model ?? '',
          tools,
          prompt: isMain ? prompt : (meta.description ?? ''),
          input: usage.input_tokens ?? 0,
          output: usage.output_tokens ?? 0,
          cacheRead: usage.cache_read_input_tokens ?? 0,
          cacheWrite: usage.cache_creation_input_tokens ?? 0,
        })
      const targets = model ? [totals, byModel.get(model) ?? byModel.set(model, emptyTotals()).get(model)!] : [totals]
      for (const target of targets) {
        target.turns += 1
        target.input += usage.input_tokens ?? 0
        target.output += usage.output_tokens ?? 0
        target.cacheRead += usage.cache_read_input_tokens ?? 0
        target.cacheWrite += usage.cache_creation_input_tokens ?? 0
        target.cost += cost
      }
    }
    if (!isMain && first <= last) busy.push([first, last])
    detail.agents.push({
      id: agentId,
      type: meta.agentType ?? 'desconhecido',
      description: meta.description ?? '',
      models: [...models],
      ...(isMain ? {} : { parent: !meta.parentAgentId || meta.parentAgentId === root ? 'main' : meta.parentAgentId }),
      ...totals,
    })
  }

  // Claude Code's saved cost covers the whole session, older lines included.
  if (since) detail.reportedCost = null
  if (idleSince !== undefined) idle.push([idleSince, Math.max(idleSince, lastAt)])
  detail.idleMs = uncovered(idle, busy)
  detail.byModel = [...byModel].map(([model, totals]) => ({ model, ...totals }))
  detail.unpriced = [...unpriced]
  detail.tools = sorted(tools)
  detail.mcp = sorted(mcp)
  detail.skills = sorted(skills)
  detail.commands = sorted(commands)
  detail.hooks = [...hooks.values()].sort((a, b) => b.runs - a.runs)
  detail.timeline.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  return detail
}

const mergeCounts = (lists: Count[][]): Count[] => {
  const counts = new Map<string, number>()
  for (const { name, count } of lists.flat()) counts.set(name, (counts.get(name) ?? 0) + count)
  return sorted(counts)
}

const addTotals = (target: TokenTotals, source: TokenTotals) => {
  for (const kind of Object.keys(source) as (keyof TokenTotals)[]) target[kind] += source[kind]
}

/** Sums several sessions into one detail; subagents are grouped by type and the chat is left out. */
export function mergeDetails(details: SessionDetail[]): SessionDetail {
  const byModel = new Map<string, TokenTotals & { model: string }>()
  const agents = new Map<string, SessionDetail['agents'][number]>()
  const hooks = new Map<string, HookRun>()
  const costs: Costs = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const timeline: CostPoint[] = []
  let idleMs = 0
  for (const detail of details) {
    idleMs += detail.idleMs
    for (const kind of Object.keys(costs) as (keyof Costs)[]) costs[kind] += detail.costs[kind]
    for (const { model, ...totals } of detail.byModel) addTotals(byModel.get(model) ?? byModel.set(model, { model, ...emptyTotals() }).get(model)!, totals)
    const agentKey = new Map<string, string>()
    for (const { id, type, description: _description, models, parent: _parent, ...totals } of detail.agents) {
      const key = id === 'main' ? 'main' : type
      agentKey.set(id, key)
      let agent = agents.get(key)
      if (!agent) agents.set(key, (agent = { id: key, type, description: id === 'main' ? 'Conversa principal' : '', models: [], ...emptyTotals() }))
      addTotals(agent, totals)
      for (const model of models) if (!agent.models.includes(model)) agent.models.push(model)
    }
    for (const hook of detail.hooks) {
      const key = `${hook.event}\n${hook.command}`
      const run = hooks.get(key) ?? hooks.set(key, { ...hook, runs: 0, failures: 0, ms: 0 }).get(key)!
      run.runs += hook.runs
      run.failures += hook.failures
      run.ms += hook.ms
    }
    for (const point of detail.timeline) {
      const agentId = agentKey.get(point.agentId) ?? point.agentId
      timeline.push({ ...point, agentId, agent: agentId === 'main' ? 'principal' : agentId })
    }
  }
  return {
    reportedCost: null,
    costs,
    idleMs,
    byModel: [...byModel.values()],
    agents: [...agents.values()],
    unpriced: [...new Set(details.flatMap((detail) => detail.unpriced))],
    tools: mergeCounts(details.map((detail) => detail.tools)),
    mcp: mergeCounts(details.map((detail) => detail.mcp)),
    skills: mergeCounts(details.map((detail) => detail.skills)),
    commands: mergeCounts(details.map((detail) => detail.commands)),
    hooks: [...hooks.values()].sort((a, b) => b.runs - a.runs),
    messages: [],
    timeline: timeline.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)),
  }
}
