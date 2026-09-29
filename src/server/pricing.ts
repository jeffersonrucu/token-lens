export type Usage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: { ephemeral_1h_input_tokens?: number }
  speed?: string
}

export type Costs = { input: number; output: number; cacheRead: number; cacheWrite: number }

type Price = { input: number; output: number; cacheRead: number; fast?: number }

// USD per million tokens, from https://platform.claude.com/docs/pt-BR/about-claude/pricing (2026-09).
// Cache writes are 1.25x input for the 5-minute TTL and 2x for 1 hour; `fast` multiplies every rate.
// ponytail: no batch or inference_geo "us" (1.1x) pricing; add if the logs start showing them.
const CLAUDE: Record<string, Price> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-mythos-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, fast: 2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, fast: 2 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, fast: 2 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-1': { input: 15, output: 75, cacheRead: 1.5 },
  'claude-opus-4': { input: 15, output: 75, cacheRead: 1.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
  'claude-3-5-haiku': { input: 0.8, output: 4, cacheRead: 0.08 },
}

/** Dollar cost of one API response by token kind, or null when the model has no known price. */
export function costOf(model: string, usage: Usage): Costs | null {
  // Dated ids such as claude-haiku-4-5-20251001 share the undated price.
  const price = CLAUDE[model.replace(/-\d{8}$/, '')]
  if (!price) return null
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  const cacheWrite1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0
  const scale = (usage.speed === 'fast' ? price.fast ?? 1 : 1) / 1_000_000
  return {
    input: (usage.input_tokens ?? 0) * price.input * scale,
    output: (usage.output_tokens ?? 0) * price.output * scale,
    cacheRead: (usage.cache_read_input_tokens ?? 0) * price.cacheRead * scale,
    cacheWrite: ((cacheWrite - cacheWrite1h) * 1.25 + cacheWrite1h * 2) * price.input * scale,
  }
}
