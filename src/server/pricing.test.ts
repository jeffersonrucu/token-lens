import assert from 'node:assert/strict'
import { test } from 'node:test'
import { costOf } from './pricing.js'

test('prices each token kind, the 1-hour cache write and fast mode', () => {
  const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 2_000_000, cache_creation: { ephemeral_1h_input_tokens: 1_000_000 } }
  // Opus 5: cache write is 6.25 (5m) + 10 (1h).
  assert.deepEqual(costOf('claude-opus-5', usage), { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 16.25 })
  assert.deepEqual(costOf('claude-opus-5', { ...usage, speed: 'fast' }), { input: 10, output: 50, cacheRead: 1, cacheWrite: 32.5 })
  assert.equal(costOf('claude-haiku-4-5-20251001', { output_tokens: 1_000_000 })?.output, 5)
  assert.equal(costOf('gpt-5-codex', usage), null)
})
