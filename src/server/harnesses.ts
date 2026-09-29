import { readFile } from 'node:fs/promises'
import { costOf, type Costs } from './pricing.js'
import { bump, emptyTotals, sorted, type ChatMessage, type CostPoint, type SessionDetail, type TokenTotals } from './session-detail.js'

export type CodexTokens = { input_tokens?: number; cached_input_tokens?: number; cache_write_input_tokens?: number; output_tokens?: number; total_tokens?: number }
type Counts = { input: number; output: number; cacheRead: number; cacheWrite: number }
type CodexEntry = {
  type?: string
  timestamp?: string
  payload?: {
    type?: string
    id?: string
    model?: string
    agent_role?: string
    agent_nickname?: string
    info?: { total_token_usage?: CodexTokens; last_token_usage?: CodexTokens } | null
    item?: { type: string; content?: { text?: string }[]; server?: string; tool?: string; kind?: string }
  }
}
type PiEntry = {
  type?: string
  timestamp?: string
  message?: {
    role?: string
    model?: string
    stopReason?: string
    content?: string | { type?: string; text?: string; name?: string }[]
    usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: Partial<Costs> }
  }
}
type Agent = { id: string; type: string; description: string }
// One API response, already in the monitor's token kinds.
type Reply = { at: string; model: string; agentId: string; prompt: string; tools: string[]; costs: Costs | null; input: number; output: number; cacheRead: number; cacheWrite: number }
type Parts = { agents: Agent[]; replies: Reply[]; messages: ChatMessage[]; tools: Map<string, number>; mcp: Map<string, number>; idleMs: number }

const PROMPT_LIMIT = 140

/** Codex counts cached tokens inside input_tokens; the monitor keeps them apart, as Claude Code does. */
export function codexCounts(usage: CodexTokens): Counts {
  const cacheRead = usage.cached_input_tokens ?? 0
  return { input: (usage.input_tokens ?? 0) - cacheRead, output: usage.output_tokens ?? 0, cacheRead, cacheWrite: usage.cache_write_input_tokens ?? 0 }
}

async function lines<T extends { timestamp?: string }>(path: string, from: number): Promise<{ at: string; entry: T }[]> {
  const text = await readFile(path, 'utf8').catch(() => '')
  return text.split('\n').flatMap((line) => {
    try {
      const entry = JSON.parse(line) as T
      const at = entry.timestamp ?? ''
      return Date.parse(at) < from ? [] : [{ at, entry }]
    } catch {
      return []
    }
  })
}

/** The session detail built from normalized replies, for harnesses without Claude Code's hooks and skills. */
function summarize({ agents, replies, messages, tools, mcp, idleMs }: Parts): SessionDetail {
  const costs: Costs = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const byModel = new Map<string, TokenTotals>()
  const totals = new Map(agents.map((agent) => [agent.id, { ...agent, models: [] as string[], ...emptyTotals() }]))
  const unpriced = new Set<string>()
  const timeline: CostPoint[] = []
  for (const reply of replies) {
    const agent = totals.get(reply.agentId)!
    if (!reply.costs) unpriced.add(reply.model)
    else for (const kind of Object.keys(costs) as (keyof Costs)[]) costs[kind] += reply.costs[kind]
    const cost = reply.costs ? reply.costs.input + reply.costs.output + reply.costs.cacheRead + reply.costs.cacheWrite : 0
    const { at, model, agentId, prompt, tools: used, input, output, cacheRead, cacheWrite } = reply
    if (cost && at) timeline.push({ at, cost, agentId, agent: agentId === 'main' ? 'principal' : agent.description || agent.type, model, tools: used, prompt, input, output, cacheRead, cacheWrite })
    for (const target of [agent, byModel.get(model) ?? byModel.set(model, emptyTotals()).get(model)!]) {
      target.turns += 1
      target.input += input
      target.output += output
      target.cacheRead += cacheRead
      target.cacheWrite += cacheWrite
      target.cost += cost
    }
    if (!agent.models.includes(model)) agent.models.push(model)
  }
  return {
    reportedCost: null,
    costs,
    idleMs,
    byModel: [...byModel].map(([model, total]) => ({ model, ...total })),
    agents: [...totals.values()],
    unpriced: [...unpriced].filter(Boolean),
    tools: sorted(tools),
    mcp: sorted(mcp),
    skills: [],
    commands: [],
    hooks: [],
    messages,
    timeline: timeline.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)),
  }
}

// Codex item types that are not a tool call.
const NOT_TOOLS = new Set(['UserMessage', 'AgentMessage', 'Reasoning', 'ContextCompaction'])
const CODEX_TOOLS: Record<string, string> = { CommandExecution: 'shell', FileChange: 'apply_patch' }

/** Reads a Codex thread and its subagent threads from `since` on. */
export async function readCodexDetail(main: string, subagents: string[], since?: string): Promise<SessionDetail> {
  const from = since ? Date.parse(since) : -Infinity
  const parts: Parts = { agents: [], replies: [], messages: [], tools: new Map(), mcp: new Map(), idleMs: 0 }
  for (const path of [main, ...subagents]) {
    const isMain = path === main
    let agent: Agent = { id: 'main', type: 'principal', description: 'Conversa principal' }
    let model = ''
    let prompt = ''
    let pending: string[] = []
    let idleSince: number | undefined
    const seen = new Set<number>()
    for (const { at, entry } of await lines<CodexEntry>(path, from)) {
      const payload = entry.payload ?? {}
      if (entry.type === 'session_meta' && !isMain && agent.id === 'main') {
        agent = { id: payload.id ?? path, type: payload.agent_role ?? 'subagente', description: payload.agent_nickname ?? '' }
        continue
      }
      if (entry.type === 'turn_context') model = payload.model ?? model
      if (payload.type === 'task_complete' && isMain) idleSince = Date.parse(at)
      if (payload.type === 'token_count' && payload.info?.last_token_usage) {
        const total = payload.info.total_token_usage?.total_tokens ?? NaN
        if (seen.has(total)) continue
        seen.add(total)
        const counts = codexCounts(payload.info.last_token_usage)
        const usage = { input_tokens: counts.input, output_tokens: counts.output, cache_read_input_tokens: counts.cacheRead, cache_creation_input_tokens: counts.cacheWrite }
        parts.replies.push({ at, model, agentId: agent.id, prompt: isMain ? prompt : agent.description, tools: pending, costs: costOf(model, usage), ...counts })
        pending = []
        continue
      }
      const item = payload.type === 'item_completed' ? payload.item : undefined
      if (!item) continue
      const text = (item.content ?? []).map((part) => part.text ?? '').join('\n').trim()
      if (item.type === 'UserMessage' && isMain) {
        if (idleSince !== undefined) parts.idleMs += Math.max(0, Date.parse(at) - idleSince)
        idleSince = undefined
        parts.messages.push({ role: 'user', at, text, tools: [] })
        prompt = text.slice(0, PROMPT_LIMIT)
        continue
      }
      if (item.type === 'AgentMessage' && isMain) {
        parts.messages.push({ role: 'assistant', at, text, tools: [] })
        continue
      }
      if (NOT_TOOLS.has(item.type)) continue
      const name = item.type === 'McpToolCall' ? `${item.server} › ${item.tool}` : item.type === 'Extension' ? (item.kind ?? 'extension') : (CODEX_TOOLS[item.type] ?? item.type)
      bump(item.type === 'McpToolCall' ? parts.mcp : parts.tools, name)
      pending.push(name)
      const last = parts.messages.at(-1)
      if (isMain && last?.role === 'assistant') last.tools.push(name)
    }
    parts.agents.push(agent)
  }
  return summarize(parts)
}

/** Reads a pi session from `since` on; pi prices each reply itself, so its cost is taken as is. */
export async function readPiDetail(main: string, _subagents: string[], since?: string): Promise<SessionDetail> {
  const from = since ? Date.parse(since) : -Infinity
  const parts: Parts = { agents: [{ id: 'main', type: 'principal', description: 'Conversa principal' }], replies: [], messages: [], tools: new Map(), mcp: new Map(), idleMs: 0 }
  let prompt = ''
  let idleSince: number | undefined
  for (const { at, entry } of await lines<PiEntry>(main, from)) {
    const message = entry.message
    if (entry.type !== 'message' || !message) continue
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : (message.content ?? [])
    const text = blocks.flatMap((block) => (block.type === 'text' && block.text ? [block.text] : [])).join('\n\n')
    if (message.role === 'user') {
      if (idleSince !== undefined) parts.idleMs += Math.max(0, Date.parse(at) - idleSince)
      idleSince = undefined
      parts.messages.push({ role: 'user', at, text, tools: [] })
      prompt = text.slice(0, PROMPT_LIMIT)
      continue
    }
    if (message.role !== 'assistant') continue
    const names = blocks.flatMap((block) => (block.type === 'toolCall' && block.name ? [block.name] : []))
    for (const name of names) bump(parts.tools, name)
    if (text || names.length) parts.messages.push({ role: 'assistant', at, text, tools: names })
    // A reply that stops without asking for a tool hands the turn back to the user.
    if (message.stopReason === 'stop') idleSince = Date.parse(at)
    const usage = message.usage
    if (!usage) continue
    const cost = usage.cost
    parts.replies.push({
      at,
      model: message.model ?? '',
      agentId: 'main',
      prompt,
      tools: names,
      costs: cost ? { input: cost.input ?? 0, output: cost.output ?? 0, cacheRead: cost.cacheRead ?? 0, cacheWrite: cost.cacheWrite ?? 0 } : null,
      input: usage.input ?? 0,
      output: usage.output ?? 0,
      cacheRead: usage.cacheRead ?? 0,
      cacheWrite: usage.cacheWrite ?? 0,
    })
  }
  return summarize(parts)
}
