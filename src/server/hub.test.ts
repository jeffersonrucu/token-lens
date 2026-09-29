import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createApp } from './app.js'
import { openDatabase } from './database.js'
import { UsageTracker } from './usage.js'

test('hub: domain, e-mail confirmation, shares, ingest and viewer access', async (t) => {
  Object.assign(process.env, { LOG_LEVEL: 'silent', MODE: 'hub', HUB_PUBLIC_URL: 'https://hub.test', HUB_ALLOWED_EMAIL_DOMAINS: 'empresa.com' })
  t.after(() => { for (const key of ['MODE', 'HUB_PUBLIC_URL', 'HUB_ALLOWED_EMAIL_DOMAINS', 'HUB_ALLOW_PUBLIC_SHARES']) delete process.env[key] })
  const sent: string[] = []
  const root = mkdtempSync(join(tmpdir(), 'hub-'))
  const app = createApp(openDatabase(':memory:'), new UsageTracker(root, join(root, 'cache.json')), async (_to, _subject, text) => { sent.push(text) })
  t.after(() => app.close())
  await app.ready()
  const account = { name: 'Dev', password: 'senha-teste-123', avatarSeed: crypto.randomUUID() }
  const link = (pattern: RegExp) => pattern.exec(sent.at(-1)!)![1]!

  const outsider = await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: { ...account, email: 'a@gmail.com' } })
  assert.equal(outsider.statusCode, 403)

  const signup = await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: { ...account, email: 'dev@empresa.com' } })
  assert.equal(signup.statusCode, 202)
  assert.equal(signup.headers['set-cookie'], undefined)
  const login = () => app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'dev@empresa.com', password: account.password } })
  assert.equal((await login()).statusCode, 403)

  const verify = await app.inject({ url: `/api/v1/auth/verify?code=${link(/code=([\w-]+)/)}` })
  assert.equal(verify.headers.location, '/?verified=1')
  const logged = await login()
  assert.equal(logged.statusCode, 200)
  assert.equal(logged.json().user.onboarded, true)
  const cookie = logged.headers['set-cookie']!.toString().split(';')[0]!

  const { key } = (await app.inject({ method: 'POST', url: '/api/v1/hub/key', headers: { cookie } })).json()
  const bearer = { authorization: `Bearer ${key}` }
  const create = (payload: object) => app.inject({ method: 'POST', url: '/api/v1/hub/shares', headers: bearer, payload: { kind: 'session', title: 'Sessão', emails: [], expiresAt: null, ...payload } })

  const created = await create({ access: 'public' })
  assert.equal(created.statusCode, 201)
  const { url, share } = created.json()
  const token = url.replace('https://hub.test/s/', '')
  const detail = { session: { id: 's1' }, timeline: [{ cost: 1, prompt: 'segredo' }], messages: [{ text: 'segredo' }] }
  assert.equal((await app.inject({ method: 'PUT', url: `/api/v1/hub/shares/${share.id}/data`, headers: bearer, payload: detail })).statusCode, 200)

  const viewed = (await app.inject({ url: `/api/v1/share/${token}` })).json()
  assert.deepEqual([viewed.detail.messages, viewed.detail.timeline[0].prompt, viewed.detail.timeline[0].cost], [[], '', 1])
  assert.equal((await app.inject({ url: '/api/v1/share/nope' })).statusCode, 404)

  // Revoking ends open streams; without it the read below hangs until the timeout.
  const live = (await create({ access: 'public' })).json()
  const address = await app.listen({ port: 0 })
  const stream = await fetch(`${address}/api/v1/share/${live.url.replace('https://hub.test/s/', '')}/stream`, { signal: AbortSignal.timeout(2_000) })
  await app.inject({ method: 'DELETE', url: `/api/v1/hub/shares/${live.share.id}`, headers: bearer })
  assert.equal(await stream.text(), ': open\n\n')

  process.env.HUB_ALLOW_PUBLIC_SHARES = 'false'
  assert.equal((await app.inject({ url: `/api/v1/share/${token}` })).statusCode, 403)
  assert.equal((await create({ access: 'public' })).statusCode, 403)

  const guarded = (await create({ access: 'emails', emails: ['Cliente@Fora.com'] })).json()
  const guardedToken = guarded.url.replace('https://hub.test/s/', '')
  assert.equal((await app.inject({ url: `/api/v1/share/${guardedToken}` })).statusCode, 403)
  assert.equal((await app.inject({ url: `/api/v1/share/${guardedToken}`, headers: { cookie } })).statusCode, 200)

  const ask = (email: string) => app.inject({ method: 'POST', url: `/api/v1/share/${guardedToken}/access`, payload: { email } })
  const before = sent.length
  assert.equal((await ask('intruso@fora.com')).statusCode, 202)
  assert.equal(sent.length, before)
  await ask('cliente@fora.com')
  const code = link(/#access=([\w-]+)/)
  const confirmed = await app.inject({ method: 'POST', url: '/api/v1/share/access/confirm', payload: { code } })
  const viewer = confirmed.headers['set-cookie']!.toString().split(';')[0]!
  assert.equal((await app.inject({ url: `/api/v1/share/${guardedToken}`, headers: { cookie: viewer } })).statusCode, 200)
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/share/access/confirm', payload: { code } })).statusCode, 400)

  await app.inject({ method: 'PUT', url: `/api/v1/hub/shares/${guarded.share.id}`, headers: bearer, payload: { access: 'emails', emails: ['cliente@fora.com'], expiresAt: '2000-01-01T00:00:00Z' } })
  assert.equal((await app.inject({ url: `/api/v1/share/${guardedToken}`, headers: { cookie: viewer } })).statusCode, 404)

  await app.inject({ method: 'DELETE', url: `/api/v1/hub/shares/${guarded.share.id}`, headers: bearer })
  assert.equal((await app.inject({ url: '/api/v1/hub/shares', headers: bearer })).json().shares.length, 1)
  assert.equal((await app.inject({ url: '/api/v1/hub/shares', headers: { authorization: 'Bearer errada' } })).statusCode, 401)

  process.env.HUB_ALLOWED_EMAIL_DOMAINS = 'outra.com'
  assert.equal((await app.inject({ url: '/api/v1/profile', headers: { cookie } })).statusCode, 401)
  assert.equal((await app.inject({ url: '/api/v1/hub/shares', headers: bearer })).statusCode, 401)
})
