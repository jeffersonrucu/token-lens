import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createApp } from './app.js'
import { openDatabase } from './database.js'
import { UsageTracker } from './usage.js'

const lines = [
  { type: 'ai-title', sessionId: 's1', aiTitle: 'Checkout do cliente-x' },
  { type: 'user', sessionId: 's1', cwd: '/home/dev/cliente-x', timestamp: '2026-01-01T12:00:00Z', message: { content: 'segredo do cliente' } },
  { type: 'assistant', sessionId: 's1', cwd: '/home/dev/cliente-x', timestamp: '2026-01-01T12:00:01Z', message: { id: 'r1', model: 'claude-opus-5', usage: { input_tokens: 10, output_tokens: 5 } } },
]

test('local: connects to a hub, shares a session with numbers only and revokes it', async (t) => {
  process.env.LOG_LEVEL = 'silent'
  // A stand-in hub that records what the local monitor sends.
  const received: { method: string; url: string; auth: string; body: any }[] = []
  let shares: { id: string }[] = []
  const hub = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => (raw += chunk))
    request.on('end', () => {
      received.push({ method: request.method!, url: request.url!, auth: request.headers.authorization!, body: raw ? JSON.parse(raw) : null })
      const send = (status: number, body: unknown) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
      if (request.headers.authorization !== 'Bearer tw_chave-valida') return send(401, {})
      if (request.method === 'POST') {
        shares = [{ id: 'h1' }]
        return send(201, { share: { id: 'h1', access: 'public' }, url: 'https://hub.test/s/abc' })
      }
      if (request.method === 'DELETE') shares = []
      send(200, { shares, ok: true })
    })
  })
  await new Promise<void>((resolve) => hub.listen(0, '127.0.0.1', resolve))
  t.after(() => hub.close())
  const hubUrl = `http://127.0.0.1:${(hub.address() as { port: number }).port}`

  const root = mkdtempSync(join(tmpdir(), 'shares-'))
  writeFileSync(join(root, 's1.jsonl'), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
  const usage = new UsageTracker(root, join(root, 'cache.json'))
  const db = openDatabase(':memory:')
  db.exec('CREATE TRIGGER onboarded AFTER INSERT ON users BEGIN UPDATE users SET onboarded_at = NEW.created_at WHERE id = NEW.id; END')
  const app = createApp(db, usage)
  t.after(() => app.close())
  await app.ready()
  await usage.scan()
  const signup = await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: { name: 'Dev', email: 'd@e.co', password: 'senha-teste-123', avatarSeed: crypto.randomUUID() } })
  const cookie = signup.headers['set-cookie']!.toString().split(';')[0]!
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) => app.inject({ method, url: `/api/v1${url}`, headers: { cookie }, payload })
  const share = { kind: 'session', scope: 's1', access: 'public', emails: [], expiresAt: null, title: 'Refatoração do checkout' }

  assert.equal((await call('POST', '/shares', share)).statusCode, 409)
  assert.equal((await call('PUT', '/hub/settings', { url: 'http://hub.remoto.com', key: 'tw_chave-valida' })).statusCode, 400)
  assert.equal((await call('PUT', '/hub/settings', { url: hubUrl, key: 'tw_chave-errada' })).statusCode, 502)
  assert.equal((await call('PUT', '/hub/settings', { url: `${hubUrl}/`, key: 'tw_chave-valida' })).json().url, hubUrl)
  assert.deepEqual((await call('GET', '/hub/settings')).json(), { url: hubUrl, connected: true })

  assert.equal((await call('GET', '/shares/default-title?kind=session&scope=s1')).json().title, 'Checkout do cliente-x')
  await call('PUT', '/privacy', { mode: 'auto', projects: [], paused: false, hideChat: false, hidePaths: true })
  assert.equal((await call('GET', '/shares/default-title?kind=session&scope=s1')).json().title, 'Sessão de 01/01/2026')

  const created = await call('POST', '/shares', share)
  assert.equal(created.statusCode, 201)
  assert.equal(created.json().share.url, 'https://hub.test/s/abc')
  const sent = received.find((request) => request.method === 'PUT' && request.url === '/api/v1/hub/shares/h1/data')!.body
  assert.equal(sent.session.title, 'Refatoração do checkout')
  assert.equal(received.find((request) => request.method === 'POST')!.body.title, 'Refatoração do checkout')
  assert.equal(sent.session.project, null)
  assert.deepEqual(sent.messages, [])
  assert.equal(sent.clear, undefined)
  assert.equal(sent.timeline[0].prompt, '')
  assert.equal(sent.timeline[0].output, 5)
  assert.doesNotMatch(JSON.stringify(sent), /segredo|cliente-x/)

  await call('POST', '/shares', { ...share, kind: 'project', scope: '/home/dev/cliente-x' })
  const project = received.filter((request) => request.method === 'PUT' && request.url.endsWith('/data')).at(-1)!.body
  assert.equal(project.session.output, 5)
  assert.doesNotMatch(JSON.stringify(project), /segredo|cliente-x/)

  const listed = (await call('GET', '/shares?kind=session&scope=s1')).json().shares
  assert.deepEqual(listed.map((item: { url: string }) => item.url), ['https://hub.test/s/abc'])

  assert.equal((await call('DELETE', '/shares/h1')).statusCode, 200)
  assert.deepEqual((await call('GET', '/shares?kind=session&scope=s1')).json().shares, [])
})
