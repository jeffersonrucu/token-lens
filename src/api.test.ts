import assert from 'node:assert/strict'
import { test } from 'node:test'
import { privacyApi, shareApi } from './api.js'
import type { Privacy } from './api.js'

test('a repeated write waits for the pending one and a different one runs after it', async (t) => {
  const calls: string[] = []
  let release = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    calls.push(`${init.method} ${url} ${init.body ?? ''}`)
    await gate
    return new Response(init.body ?? '{"ok":true}')
  })

  const first = shareApi.revoke('a')
  const again = shareApi.revoke('a')
  assert.equal(first, again)

  const on = { hideChat: true } as Privacy
  const saves = [privacyApi.save(on), privacyApi.save({ ...on, hideChat: false })]
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(calls, ['DELETE /api/v1/shares/a ', 'PUT /api/v1/privacy {"hideChat":true}'])

  release()
  assert.deepEqual(await Promise.all(saves), [on, { hideChat: false }])
  assert.equal(calls.at(-1), 'PUT /api/v1/privacy {"hideChat":false}')
  await first
  await shareApi.revoke('a')
  assert.equal(calls.length, 4)
})
