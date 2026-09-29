import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { createApp } from './app.js'
import { consumeEmailCode, createEmailCode, emailAllowed } from './auth.js'
import { openDatabase } from './database.js'
import { UsageTracker } from './usage.js'

test('e-mail domains and single-use codes', (t) => {
  t.after(() => delete process.env.HUB_ALLOWED_EMAIL_DOMAINS)
  assert.equal(emailAllowed('a@qualquer.com'), true)
  process.env.HUB_ALLOWED_EMAIL_DOMAINS = ' Empresa.com , outra.com'
  assert.equal(emailAllowed('a@EMPRESA.com'), true)
  assert.equal(emailAllowed('a@gmail.com'), false)

  const db = openDatabase(':memory:')
  const code = createEmailCode(db, 'verify', 'a@e.co', 10)
  assert.equal(consumeEmailCode(db, 'viewer', code), undefined)
  assert.equal(consumeEmailCode(db, 'verify', code), 'a@e.co')
  assert.equal(consumeEmailCode(db, 'verify', code), undefined)
  assert.equal(consumeEmailCode(db, 'verify', createEmailCode(db, 'verify', 'a@e.co', -1)), undefined)
})

test('signs up, logs in and out, and refuses foreign origins', async (t) => {
  process.env.LOG_LEVEL = 'silent'
  const app = createApp(openDatabase(':memory:'), new UsageTracker('/nonexistent', '/nonexistent/cache.json'))
  t.after(() => app.close())
  await app.ready()
  const account = { name: 'Dev', email: 'Dev@E.co', password: 'senha-teste-123', avatarSeed: crypto.randomUUID() }
  const cookieOf = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!
  const profile = (cookie?: string) => app.inject({ url: '/api/v1/profile', headers: cookie ? { cookie } : {} })

  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: { ...account, password: 'curta' } })).statusCode, 400)
  const signup = await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: account })
  assert.equal(signup.statusCode, 201)
  assert.equal(signup.json().user.email, 'dev@e.co')
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: account })).statusCode, 409)

  const foreign = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'https://evil.test' }, payload: account })
  assert.equal(foreign.statusCode, 403)
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { ...account, password: 'errada-123' } })).statusCode, 401)
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'http://127.0.0.1:47832' }, payload: account })
  assert.equal(login.statusCode, 200)

  const cookie = cookieOf(login)
  assert.equal((await profile(cookie)).statusCode, 200)
  assert.equal((await profile()).statusCode, 401)
  await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie } })
  assert.equal((await profile(cookie)).statusCode, 401)
  assert.equal((await profile(cookieOf(signup))).statusCode, 200)
})

test('a database from before migrations gets the missing columns once', (t) => {
  const path = join(mkdtempSync(join(tmpdir(), 'tokenlens-db-')), 'app.db')
  t.after(() => rmSync(dirname(path), { recursive: true, force: true }))
  const old = new DatabaseSync(path)
  old.exec("CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, avatar_seed TEXT NOT NULL, created_at TEXT NOT NULL)")
  old.exec("INSERT INTO users VALUES ('u', 'Ana', 'a@e.co', 'h', 's', '2026-01-01')")
  old.close()

  openDatabase(path).close()
  const db = openDatabase(path)
  assert.deepEqual({ ...db.prepare('SELECT onboarded_at, verified_at FROM users').get() }, { onboarded_at: '2026-01-01', verified_at: '2026-01-01' })
  assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 2)
})

test('accepts the page origin when the app takes another port', async (t) => {
  process.env.LOG_LEVEL = 'silent'
  process.env.PORT = '47840'
  const app = createApp(openDatabase(':memory:'), new UsageTracker('/nonexistent', '/nonexistent/cache.json'))
  t.after(() => {
    delete process.env.PORT
    return app.close()
  })
  await app.ready()
  const login = (origin: string) =>
    app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin }, payload: { email: 'dev@e.co', password: 'senha-teste-123' } })
  // 401 is the credential check: the origin was accepted.
  assert.equal((await login('http://127.0.0.1:47840')).statusCode, 401)
  assert.equal((await login('http://127.0.0.1:47999')).statusCode, 403)
})
