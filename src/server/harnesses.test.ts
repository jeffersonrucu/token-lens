import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readCodexDetail, readPiDetail } from './harnesses.js'
import { UsageTracker } from './usage.js'

const MAIN = '01a00000-0000-7000-8000-000000000001'
const CHILD = '01a00000-0000-7000-8000-000000000002'
const lines = (entries: object[]) => `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`
const tokens = (input: number, cached: number, output: number, total: number) => ({
  type: 'event_msg', timestamp: `2026-01-01T00:00:${String(total % 60).padStart(2, '0')}Z`,
  payload: { type: 'token_count', info: { total_token_usage: { total_tokens: total }, last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } },
})

test('Codex: repeated counts add once, cached input is split out and subagents join the parent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-'))
  const day = join(root, 'codex', '2026', '01', '01')
  mkdirSync(day, { recursive: true })
  const main = join(day, `rollout-2026-01-01T00-00-00-${MAIN}.jsonl`)
  const child = join(day, `rollout-2026-01-01T00-00-01-${CHILD}.jsonl`)
  writeFileSync(main, lines([
    { type: 'session_meta', payload: { id: MAIN, session_id: MAIN, cwd: '/repo' } },
    { type: 'turn_context', payload: { model: 'gpt-5.6-terra' } },
    { type: 'event_msg', timestamp: '2026-01-01T00:00:01Z', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ text: 'corrija o build' }] } } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution' } } },
    tokens(100, 60, 5, 105),
    // Same running total: Codex repeating the last count.
    tokens(100, 60, 5, 105),
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'McpToolCall', server: 'figma', tool: 'get_screenshot' } } },
    tokens(200, 150, 10, 315),
  ]))
  // The subagent's file opens with its own meta and then repeats the parent's.
  writeFileSync(child, lines([
    { type: 'session_meta', payload: { id: CHILD, session_id: MAIN, thread_source: 'subagent', agent_role: 'reviewer', agent_nickname: 'Ada' } },
    { type: 'session_meta', payload: { id: MAIN, session_id: MAIN } },
    { type: 'turn_context', payload: { model: 'gpt-5.5' } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ text: 'revise' }] } } },
    tokens(50, 0, 7, 57),
  ]))

  const tracker = new UsageTracker([{ harness: 'codex', root: join(root, 'codex') }], join(root, 'cache.json'))
  await tracker.scan()
  const [session] = tracker.list()
  assert.equal(tracker.list().length, 1)
  assert.deepEqual(
    { id: session.id, harness: session.harness, title: session.title, project: session.project, turns: session.turns, input: session.input, cacheRead: session.cacheRead, output: session.output },
    { id: MAIN, harness: 'codex', title: 'corrija o build', project: '/repo', turns: 3, input: 140, cacheRead: 210, output: 22 },
  )
  assert.deepEqual(session.models.sort(), ['gpt-5.5', 'gpt-5.6-terra'])

  const { harness, main: found, subagents } = tracker.transcripts(MAIN)
  assert.deepEqual([harness, found, subagents], ['codex', main, [child]])
  const detail = await readCodexDetail(main, subagents)
  assert.deepEqual(detail.agents.map((agent) => [agent.type, agent.turns]), [['principal', 2], ['reviewer', 1]])
  assert.deepEqual(detail.tools, [{ name: 'shell', count: 1 }])
  assert.deepEqual(detail.mcp, [{ name: 'figma › get_screenshot', count: 1 }])
  assert.deepEqual(detail.messages.map((message) => message.text), ['corrija o build'])
  assert.deepEqual(detail.unpriced.sort(), ['gpt-5.5', 'gpt-5.6-terra'])
})

test('pi: totals come from each reply and the cost pi computed is kept', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-'))
  const folder = join(root, 'pi', '--repo--')
  mkdirSync(folder, { recursive: true })
  const file = join(folder, `2026-01-01T00-00-00-000Z_${MAIN}.jsonl`)
  const usage = { input: 10, output: 4, cacheRead: 90, cacheWrite: 0, cost: { input: 0.1, output: 0.2, cacheRead: 0.05, cacheWrite: 0, total: 0.35 } }
  writeFileSync(file, lines([
    { type: 'session', id: MAIN, cwd: '/repo', timestamp: '2026-01-01T00:00:00Z' },
    { type: 'message', id: 'a1', timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: [{ type: 'text', text: 'olá' }] } },
    { type: 'message', id: 'a2', timestamp: '2026-01-01T00:00:02Z', message: { role: 'assistant', model: 'gpt-5.5', usage, stopReason: 'toolUse', content: [{ type: 'toolCall', name: 'bash' }] } },
    { type: 'message', id: 'a3', timestamp: '2026-01-01T00:00:03Z', message: { role: 'assistant', model: 'gpt-5.5', usage, stopReason: 'stop', content: [{ type: 'text', text: 'pronto' }] } },
    { type: 'session_info', timestamp: '2026-01-01T00:00:04Z', name: 'Meu título' },
  ]))

  const tracker = new UsageTracker([{ harness: 'pi', root: join(root, 'pi') }], join(root, 'cache.json'))
  await tracker.scan()
  const [session] = tracker.list()
  assert.deepEqual(
    { harness: session.harness, title: session.title, project: session.project, turns: session.turns, input: session.input, cacheRead: session.cacheRead, output: session.output },
    { harness: 'pi', title: 'Meu título', project: '/repo', turns: 2, input: 20, cacheRead: 180, output: 8 },
  )

  const detail = await readPiDetail(file, [])
  assert.equal(Math.round(detail.costs.output * 100), 40)
  assert.equal(detail.timeline.length, 2)
  assert.deepEqual(detail.tools, [{ name: 'bash', count: 1 }])
  assert.deepEqual(detail.messages.map((message) => [message.role, message.text]), [['user', 'olá'], ['assistant', ''], ['assistant', 'pronto']])
  assert.deepEqual(detail.unpriced, [])
})
