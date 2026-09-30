import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { UsageTracker } from './usage.js'

const assistant = (id: string, model: string, output: number, at: string) => JSON.stringify({
  type: 'assistant', sessionId: 's1', cwd: '/repo', timestamp: at,
  message: { id, model, usage: { input_tokens: 2, output_tokens: output, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 } },
})

test('sums each message once, includes subagents and ignores a partial last line', async () => {
  const root = mkdtempSync(join(tmpdir(), 'usage-'))
  mkdirSync(join(root, 'proj', 's1', 'subagents'), { recursive: true })
  writeFileSync(join(root, 'proj', 's1.jsonl'), [
    // Same reply over two lines: the last one holds the final output.
    assistant('m1', 'claude-opus-5', 1, '2026-01-01T00:00:01Z'),
    assistant('m1', 'claude-opus-5', 5, '2026-01-01T00:00:02Z'),
    JSON.stringify({ type: 'ai-title', aiTitle: 'Título', sessionId: 's1' }),
    '{"type":"user","message":{"content":"oi"}}',
    assistant('m3', 'claude-opus-5', 99, '2026-01-01T00:00:09Z').slice(0, 40),
  ].join('\n'))
  writeFileSync(join(root, 'proj', 's1', 'subagents', 'agent-a.jsonl'), `${assistant('m2', 'claude-haiku-4-5', 7, '2026-01-01T00:00:05Z')}\n`)

  const tracker = new UsageTracker(root, join(root, 'cache.json'))
  await tracker.scan()
  const [session] = tracker.list()

  assert.equal(tracker.list().length, 1)
  assert.deepEqual(
    { turns: session.turns, input: session.input, output: session.output, cacheRead: session.cacheRead, cacheWrite: session.cacheWrite },
    { turns: 2, input: 4, output: 12, cacheRead: 200, cacheWrite: 20 },
  )
  assert.equal(session.title, 'Título')
  assert.equal(session.project, '/repo')
  assert.deepEqual(session.models.sort(), ['claude-haiku-4-5', 'claude-opus-5'])
  assert.equal(session.lastAt, '2026-01-01T00:00:05Z')

  const finished = assistant('m3', 'claude-opus-5', 99, '2026-01-01T00:00:09Z')
  appendFileSync(join(root, 'proj', 's1.jsonl'), `${finished.slice(40)}\n`)
  await tracker.scan()
  assert.deepEqual([tracker.list()[0].turns, tracker.list()[0].output], [3, 111])
})

test('a restart reads only what was written after the cache', async () => {
  const root = mkdtempSync(join(tmpdir(), 'usage-'))
  const cache = join(root, 'cache.json')
  const file = join(root, 's1.jsonl')
  writeFileSync(file, `${assistant('m1', 'claude-opus-5', 5, '2026-01-01T00:00:01Z')}\n`)
  await new UsageTracker(root, cache).scan()

  // Rewriting the old line would be counted twice if the offset were not restored.
  appendFileSync(file, `${assistant('m2', 'claude-opus-5', 7, '2026-01-01T00:00:02Z')}\n`)
  writeFileSync(file, readFileSync(file, 'utf8').replace('"output_tokens":5', '"output_tokens":500'))
  const restarted = new UsageTracker(root, cache)
  await restarted.scan()

  assert.deepEqual([restarted.list()[0].turns, restarted.list()[0].output], [2, 12])
})

test('a cache that cannot be written does not stop later reads', async () => {
  const root = mkdtempSync(join(tmpdir(), 'usage-'))
  const file = join(root, 's1.jsonl')
  writeFileSync(file, `${assistant('m1', 'claude-opus-5', 5, '2026-01-01T00:00:01Z')}\n`)
  // A file where the cache folder should be makes every save fail.
  const tracker = new UsageTracker(root, join(file, 'cache.json'))
  await tracker.scan()

  appendFileSync(file, `${assistant('m2', 'claude-opus-5', 7, '2026-01-01T00:00:02Z')}\n`)
  await tracker.scan()

  assert.deepEqual([tracker.list()[0].turns, tracker.list()[0].output], [2, 12])
})

test('a usage line cut by the 4 MB read chunk is counted once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'usage-'))
  const line = assistant('m2', 'claude-opus-5', 7, '2026-01-01T00:00:02Z')
  const first = `${assistant('m1', 'claude-opus-5', 5, '2026-01-01T00:00:01Z')}\n`
  // Pads so the chunk ends in the middle of the second usage line.
  const padding = `${'x'.repeat(4 * 1024 * 1024 - first.length - line.length / 2 - 1)}\n`
  writeFileSync(join(root, 's1.jsonl'), `${first}${padding}${line}\n`)
  const tracker = new UsageTracker(root, join(root, 'cache.json'))
  await tracker.scan()

  assert.deepEqual([tracker.list()[0].turns, tracker.list()[0].output], [2, 12])
})

test('a second scan reports the sessions it changed, not only a snapshot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'usage-'))
  mkdirSync(join(root, 'proj'), { recursive: true })
  writeFileSync(join(root, 'proj', 's1.jsonl'), `${assistant('m1', 'claude-opus-5', 1, '2026-01-01T00:00:01Z')}\n`)

  const tracker = new UsageTracker(root, join(root, 'cache.json'))
  const events: string[] = []
  tracker.subscribe((event) => events.push(event))
  await tracker.scan()
  // The first pass is the whole history: it would mark every session as changed.
  assert.deepEqual(events, ['snapshot'])

  appendFileSync(join(root, 'proj', 's1.jsonl'), `${assistant('m2', 'claude-opus-5', 3, '2026-01-01T00:00:04Z')}\n`)
  await tracker.scan()
  assert.deepEqual(events, ['snapshot', 'snapshot', 'update'])

  await tracker.scan()
  // Nothing new: the open detail is not told to reload.
  assert.deepEqual(events, ['snapshot', 'snapshot', 'update', 'snapshot'])
})

test('a page that reconnects reads what changed while none was open', { timeout: 5_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'usage-'))
  mkdirSync(join(root, 'proj'), { recursive: true })
  writeFileSync(join(root, 'proj', 's1.jsonl'), `${assistant('m1', 'claude-opus-5', 1, '2026-01-01T00:00:01Z')}\n`)

  const tracker = new UsageTracker(root, join(root, 'cache.json'))
  const first = tracker.subscribe(() => {})
  await tracker.scan()
  // The window was minimized: the stream closed and the poll stopped reading.
  first()

  appendFileSync(join(root, 'proj', 's1.jsonl'), `${assistant('m2', 'claude-opus-5', 3, '2026-01-01T00:00:04Z')}\n`)
  const events: string[] = []
  await new Promise<void>((resolve) => {
    tracker.subscribe((event) => {
      events.push(event)
      if (event === 'update') resolve()
    })
  })

  assert.deepEqual(events, ['snapshot', 'update'])
  assert.deepEqual([tracker.list()[0].turns, tracker.list()[0].output], [2, 4])
})

test('prices each reply once and buckets the spend by hour', async () => {
  const root = mkdtempSync(join(tmpdir(), 'usage-'))
  writeFileSync(join(root, 's1.jsonl'), [
    // A reply split over two lines is priced by its final numbers only.
    assistant('m1', 'claude-opus-5', 1, '2026-01-01T00:00:01Z'),
    assistant('m1', 'claude-opus-5', 5, '2026-01-01T00:00:02Z'),
    assistant('m2', 'claude-haiku-4-5', 7, '2026-01-01T01:30:00Z'),
    assistant('m3', 'unknown-model', 7, '2026-01-01T01:40:00Z'),
  ].join('\n') + '\n')
  const tracker = new UsageTracker(root, join(root, 'cache.json'))
  await tracker.scan()
  const sessions = tracker.list()

  // opus-5: 2×5 + 5×25 + 100×0.5 + 10×1.25×5; haiku-4-5: 2×1 + 7×5 + 100×0.1 + 10×1.25×1 (per million).
  assert.ok(Math.abs(sessions[0].cost - (247.5 + 59.5) / 1e6) < 1e-12)
  const spend = [...tracker.spend(sessions, '2026-01-01T00:00:00Z')]
  assert.deepEqual(spend.map(([hour]) => new Date(hour).toISOString()), ['2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z'])
  assert.ok(Math.abs(spend[0][1] - 247.5e-6) < 1e-12)
  assert.deepEqual([...tracker.spend(sessions, '2026-01-01T01:00:00Z')].length, 1)
})

test('tracks the live context, /loop, failed hooks and where the cost went', async () => {
  const root = mkdtempSync(join(tmpdir(), 'usage-'))
  const agents = join(root, 'proj', 's1', 'subagents')
  mkdirSync(agents, { recursive: true })
  const reply = (id: string, context: number, at: string, content: object[] = []) => JSON.stringify({
    type: 'assistant', sessionId: 's1', timestamp: at,
    message: { id, model: 'claude-opus-5', content, usage: { input_tokens: 0, output_tokens: 10, cache_read_input_tokens: context, cache_creation_input_tokens: 0 } },
  })
  writeFileSync(join(root, 'proj', 's1.jsonl'), [
    reply('m1', 150_000, '2026-01-01T00:00:01Z', [{ type: 'tool_use', name: 'ScheduleWakeup' }]),
    JSON.stringify({ type: 'attachment', sessionId: 's1', attachment: { type: 'hook_cancelled', hookEvent: 'Stop', command: 'ingest', durationMs: 10_000 } }),
    reply('m2', 20_000, '2026-01-01T00:00:02Z'),
  ].join('\n') + '\n')
  writeFileSync(join(agents, 'agent-a.jsonl'), `${reply('m3', 30_000, '2026-01-01T00:00:03Z')}\n`)
  writeFileSync(join(agents, 'agent-a.meta.json'), JSON.stringify({ agentType: 'worker' }))

  const tracker = new UsageTracker(root, join(root, 'cache.json'))
  await tracker.scan()
  const [session] = tracker.list()

  // The subagent's reply is later but its context is its own, not the session's.
  assert.equal(session.context, 20_000)
  assert.equal(session.loop, true)
  assert.deepEqual(session.hookFailures, { 'Stop · ingest': { count: 1, ms: 10_000 } })
  const split = tracker.breakdown([session], '2026-01-01T00:00:00Z')
  const cost = (tokens: number) => tokens * 0.5 / 1e6 + 10 * 25 / 1e6
  assert.ok(Math.abs(split.subagents - cost(30_000)) < 1e-9)
  assert.ok(Math.abs(split.bigContext - cost(150_000)) < 1e-9)
  assert.equal(split.loop, split.cost)
  assert.deepEqual(split.agents.map(({ agent, turns }) => [agent, turns]), [['principal', 2], ['worker', 1]])
})
