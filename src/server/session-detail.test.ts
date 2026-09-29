import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { mergeDetails, readSessionDetail } from './session-detail.js'

const usage = { input_tokens: 1, output_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 }
const line = (entry: object) => JSON.stringify({ sessionId: 's1', timestamp: '2026-01-01T00:00:00Z', ...entry })

test('breaks a session down by model, agent, tool, hook and message', async () => {
  const root = mkdtempSync(join(tmpdir(), 'detail-'))
  mkdirSync(join(root, 's1', 'subagents'), { recursive: true })
  const main = join(root, 's1.jsonl')
  const agent = join(root, 's1', 'subagents', 'agent-a1.jsonl')
  writeFileSync(main, [
    line({ type: 'user', message: { content: '<command-name>/review</command-name>\n<command-args>now</command-args>' } }),
    line({ type: 'user', isMeta: true, message: { content: [{ type: 'text', text: 'Base directory for this skill: /x/review' }] } }),
    line({ type: 'user', isMeta: true, origin: { name: 'peer', body: 'faça X' }, message: { content: 'wrapped' } }),
    // Two lines of the same reply: one message, usage taken from the last line.
    line({ type: 'assistant', message: { id: 'm1', model: 'claude-opus-5', usage: { ...usage, output_tokens: 1 }, content: [{ type: 'text', text: 'Olá' }] } }),
    line({ type: 'assistant', message: { id: 'm1', model: 'claude-opus-5', usage, content: [
      { type: 'tool_use', name: 'Skill', input: { skill: 'simplify' } },
      { type: 'tool_use', name: 'mcp__figma__get_screenshot' },
    ] } }),
    line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
    line({ type: 'attachment', attachment: { type: 'hook_success', hookEvent: 'PostToolUse', command: 'lint', durationMs: 20 } }),
    line({ type: 'attachment', attachment: { type: 'hook_cancelled', hookEvent: 'Stop', command: 'ingest', durationMs: 50 } }),
    line({ type: 'system', subtype: 'stop_hook_summary', hookInfos: [{ command: 'ingest', durationMs: 50 }] }),
    line({ type: 'system', subtype: 'turn_duration', durationMs: 4000 }),
    // Waiting for the user from the end of the turn until the next prompt.
    line({ type: 'user', timestamp: '2026-01-01T00:00:30Z', message: { content: 'de novo' } }),
    line({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'manual', preTokens: 900, postTokens: 90 } }),
    line({ type: 'cost-state', totalCostUSD: 1.5 }),
    '{"broken',
  ].join('\n'))
  // The subagent runs 10 s into the main thread's wait, so only 20 s count as idle.
  writeFileSync(agent, [
    line({ type: 'assistant', isSidechain: true, message: { id: 'm2', model: 'claude-haiku-4-5-20251001', usage, content: [{ type: 'tool_use', name: 'Bash' }] } }),
    line({ type: 'user', isSidechain: true, timestamp: '2026-01-01T00:00:10Z', message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
  ].join('\n'))
  writeFileSync(join(root, 's1', 'subagents', 'agent-a1.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Busca' }))

  const detail = await readSessionDetail(main, [agent])

  assert.equal(detail.idleMs, 20_000)
  assert.equal(detail.reportedCost, 1.5)
  assert.deepEqual(detail.byModel.map((row) => [row.model, row.turns, row.output]), [['claude-opus-5', 1, 10], ['claude-haiku-4-5-20251001', 1, 10]])
  assert.deepEqual(detail.agents.map((row) => [row.id, row.type, row.turns, row.models]), [['main', 'principal', 1, ['claude-opus-5']], ['a1', 'Explore', 1, ['claude-haiku-4-5-20251001']]])
  // Opus 5: 1*5 + 10*25 + 100*0.5 + 5*5*1.25 = 336.25 per million.
  assert.equal(detail.agents[0].cost.toFixed(8), (336.25 / 1e6).toFixed(8))
  // Output: 10 tokens at 25 (Opus 5) plus 10 at 5 (Haiku 4.5) per million.
  assert.equal(detail.costs.output.toFixed(8), (300 / 1e6).toFixed(8))
  assert.deepEqual(detail.unpriced, [])
  assert.deepEqual(detail.timeline.map((point) => point.cost.toFixed(8)), [(336.25 / 1e6).toFixed(8), (detail.agents[1].cost).toFixed(8)])
  assert.deepEqual(detail.timeline.map((point) => [point.agentId, point.agent, point.tools, point.prompt, point.cacheRead]), [
    ['main', 'principal', ['Skill', 'mcp__figma__get_screenshot'], '[peer] faça X', 100],
    ['a1', 'Explore: Busca', ['Bash'], 'Busca', 100],
  ])
  assert.deepEqual(detail.tools, [{ name: 'Skill', count: 1 }, { name: 'Bash', count: 1 }])
  assert.deepEqual(detail.mcp, [{ name: 'figma › get_screenshot', count: 1 }])
  assert.deepEqual(detail.skills, [{ name: 'review', count: 1 }, { name: 'simplify', count: 1 }])
  assert.deepEqual(detail.commands, [{ name: '/review', count: 1 }])
  assert.deepEqual(detail.compactions, [{ at: '2026-01-01T00:00:00Z', trigger: 'manual', preTokens: 900, postTokens: 90 }])
  assert.deepEqual(detail.hooks.map((hook) => [hook.event, hook.runs, hook.failures]), [['PostToolUse', 1, 0], ['Stop', 1, 1]])
  assert.deepEqual(detail.messages.map((message) => [message.role, message.text, message.tools]), [
    ['user', '/review now', []],
    ['user', '[peer] faça X', []],
    ['assistant', 'Olá', ['Skill', 'mcp__figma__get_screenshot']],
    ['user', 'de novo', []],
  ])
})

test('drops the saved cost once a resumed session replies again', async () => {
  const main = join(mkdtempSync(join(tmpdir(), 'detail-')), 's1.jsonl')
  writeFileSync(main, [
    line({ type: 'cost-state', totalCostUSD: 1.5 }),
    line({ type: 'assistant', message: { id: 'm1', model: 'claude-opus-5', usage, content: [{ type: 'text', text: 'Voltei' }] } }),
  ].join('\n'))

  assert.equal((await readSessionDetail(main, [])).reportedCost, null)
})

test('tells who started each subagent and reads one on its own', async () => {
  const root = mkdtempSync(join(tmpdir(), 'detail-'))
  const folder = join(root, 's1', 'subagents')
  mkdirSync(folder, { recursive: true })
  const main = join(root, 's1.jsonl')
  writeFileSync(main, line({ type: 'user', message: { content: 'oi' } }))
  const subagent = (id: string, meta: object) => {
    const path = join(folder, `agent-${id}.jsonl`)
    writeFileSync(path, [
      line({ type: 'user', isSidechain: true, message: { content: `tarefa ${id}` } }),
      line({ type: 'assistant', isSidechain: true, message: { id: `m-${id}`, model: 'claude-opus-5', usage, content: [{ type: 'text', text: `feito ${id}` }] } }),
    ].join('\n'))
    writeFileSync(join(folder, `agent-${id}.meta.json`), JSON.stringify(meta))
    return path
  }
  const a1 = subagent('a1', { agentType: 'Explore', description: 'Busca' })
  const a2 = subagent('a2', { agentType: 'Explore', description: 'Sub-busca', parentAgentId: 'a1' })

  const detail = await readSessionDetail(main, [a1, a2])
  assert.deepEqual(detail.agents.map((row) => [row.id, row.parent]), [['main', undefined], ['a1', 'main'], ['a2', 'a1']])
  assert.deepEqual(detail.messages.map((message) => message.text), ['oi'])
  assert.deepEqual(mergeDetails([detail]).agents.map((row) => [row.id, row.turns, 'parent' in row]), [['main', 0, false], ['Explore', 2, false]])

  const own = await readSessionDetail(a1, [])
  assert.deepEqual(own.messages.map((message) => [message.role, message.text]), [['user', 'tarefa a1'], ['assistant', 'feito a1']])
  assert.deepEqual(own.agents.map((row) => [row.id, row.type, row.description, row.turns]), [['main', 'Explore', 'Busca', 1]])
})
