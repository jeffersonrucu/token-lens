import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createApp } from './app.js'
import { openDatabase } from './database.js'
import { UsageTracker } from './usage.js'

const prompt = (n: number) => JSON.stringify({ type: 'user', sessionId: 's1', timestamp: '2026-01-01T00:00:00Z', message: { content: `m${n}` } })
const reply = JSON.stringify({ type: 'assistant', sessionId: 's1', timestamp: '2026-01-01T00:00:01Z', message: { id: 'r1', model: 'claude-opus-5', usage: { output_tokens: 1 } } })

// These tests read usage right after sign-up, so accounts skip the first-run setup.
function onboardedDatabase() {
  const db = openDatabase(':memory:')
  db.exec('CREATE TRIGGER onboarded AFTER INSERT ON users BEGIN UPDATE users SET onboarded_at = NEW.created_at WHERE id = NEW.id; END')
  return db
}

test('pages the chat backwards and keeps the tail start across refreshes', async (t) => {
  process.env.LOG_LEVEL = 'silent'
  const root = mkdtempSync(join(tmpdir(), 'routes-'))
  const file = join(root, 's1.jsonl')
  writeFileSync(file, `${[reply, ...Array.from({ length: 120 }, (_, n) => prompt(n))].join('\n')}\n`)
  const usage = new UsageTracker(root, join(root, 'cache.json'))
  const app = createApp(onboardedDatabase(), usage)
  t.after(() => app.close())
  await app.ready()
  await usage.scan()
  const signup = await app.inject({
    method: 'POST', url: '/api/v1/auth/signup',
    payload: { name: 'Teste', email: 'a@b.co', password: 'senha-teste-123', avatarSeed: crypto.randomUUID() },
  })
  const cookie = signup.headers['set-cookie']!.toString().split(';')[0]
  const get = (url: string) => app.inject({ url: `/api/v1/usage/sessions/s1${url}`, headers: { cookie } })

  const detail = (await get('')).json()
  assert.equal(detail.messageStart, 70)
  assert.deepEqual([detail.messages.length, detail.messages[0].text], [50, 'm70'])

  const page = (await get('/messages?before=70')).json()
  assert.deepEqual([page.start, page.messages.length, page.messages[0].text], [20, 50, 'm20'])
  const first = (await get('/messages?before=20')).json()
  assert.deepEqual([first.start, first.messages.length], [0, 20])

  appendFileSync(file, `${prompt(120)}\n`)
  const refreshed = (await get('?since=70')).json()
  assert.deepEqual([refreshed.messageStart, refreshed.messages.length], [70, 51])

  assert.equal((await get('/messages?before=-1')).statusCode, 400)
  assert.equal((await app.inject({ url: '/api/v1/usage/sessions/s1' })).statusCode, 401)
  assert.equal((await app.inject({ url: '/api/v1/usage/sessions/nope', headers: { cookie } })).statusCode, 404)
})

test('a cached session detail is read again once a reply is added', async (t) => {
  process.env.LOG_LEVEL = 'silent'
  const root = mkdtempSync(join(tmpdir(), 'cache-'))
  const file = join(root, 's1.jsonl')
  const answer = (id: string) => JSON.stringify({ type: 'assistant', sessionId: 's1', timestamp: `2026-01-01T00:00:0${id.length}Z`, message: { id, model: 'claude-opus-5', usage: { output_tokens: 1 } } })
  writeFileSync(file, `${answer('r')}\n`)
  const usage = new UsageTracker(root, join(root, 'cache.json'))
  const app = createApp(onboardedDatabase(), usage)
  t.after(() => app.close())
  await app.ready()
  await usage.scan()
  const signup = await app.inject({
    method: 'POST', url: '/api/v1/auth/signup',
    payload: { name: 'Teste', email: 'a@b.co', password: 'senha-teste-123', avatarSeed: crypto.randomUUID() },
  })
  const cookie = signup.headers['set-cookie']!.toString().split(';')[0]
  const get = async () => (await app.inject({ url: '/api/v1/usage/sessions/s1', headers: { cookie } })).json()

  assert.deepEqual([(await get()).timeline.length, (await get()).timeline.length], [1, 1])
  appendFileSync(file, `${answer('r2')}\n`)
  await usage.scan()
  const fresh = await get()
  assert.deepEqual([fresh.session.turns, fresh.timeline.length], [2, 2])
})

test('opens one subagent of a session with its own numbers and chat', async (t) => {
  process.env.LOG_LEVEL = 'silent'
  const root = mkdtempSync(join(tmpdir(), 'agent-'))
  mkdirSync(join(root, 's1', 'subagents'), { recursive: true })
  writeFileSync(join(root, 's1.jsonl'), `${[prompt(0), reply].join('\n')}\n`)
  const task = JSON.stringify({ type: 'user', isSidechain: true, sessionId: 's1', timestamp: '2026-01-01T00:00:02Z', message: { content: 'tarefa' } })
  const done = JSON.stringify({ type: 'assistant', isSidechain: true, sessionId: 's1', timestamp: '2026-01-01T00:00:03Z', message: { id: 'r2', model: 'claude-opus-5', usage: { output_tokens: 7 }, content: [{ type: 'text', text: 'feito' }] } })
  writeFileSync(join(root, 's1', 'subagents', 'agent-a1.jsonl'), `${[task, done].join('\n')}\n`)
  writeFileSync(join(root, 's1', 'subagents', 'agent-a1.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Busca' }))
  const nested = done.replace('"r2"', '"r3"').replace('"output_tokens":7', '"output_tokens":3')
  writeFileSync(join(root, 's1', 'subagents', 'agent-a2.jsonl'), `${nested}\n`)
  writeFileSync(join(root, 's1', 'subagents', 'agent-a2.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Sub-busca', parentAgentId: 'a1' }))
  const usage = new UsageTracker(root, join(root, 'cache.json'))
  const app = createApp(onboardedDatabase(), usage)
  t.after(() => app.close())
  await app.ready()
  await usage.scan()
  const signup = await app.inject({
    method: 'POST', url: '/api/v1/auth/signup',
    payload: { name: 'Teste', email: 'a@b.co', password: 'senha-teste-123', avatarSeed: crypto.randomUUID() },
  })
  const cookie = signup.headers['set-cookie']!.toString().split(';')[0]
  const get = (query: string) => app.inject({ url: `/api/v1/usage/sessions/s1${query}`, headers: { cookie } })

  const whole = (await get('')).json()
  const parents = (detail: { agents: { id: string; parent?: string }[] }) => detail.agents.map((agent) => [agent.id, agent.parent])
  assert.deepEqual(parents(whole), [['main', undefined], ['a1', 'main'], ['a2', 'a1']])
  // A subagent's detail counts its descendants and names who started it.
  const agent = (await get('?agent=a1')).json()
  assert.deepEqual([agent.session.title, agent.session.turns, agent.session.output], ['Busca', 2, 10])
  assert.deepEqual([parents(agent), agent.startedBy], [[['main', undefined], ['a2', 'main']], { id: 'main', name: 'Conversa principal' }])
  assert.deepEqual((await get('?agent=a2')).json().startedBy, { id: 'a1', name: 'Busca' })
  assert.deepEqual(agent.messages.map((message: { text: string }) => message.text), ['tarefa', 'feito'])
  assert.equal((await get('/messages?before=1&agent=a1')).json().messages[0].text, 'tarefa')
  assert.equal((await get('?agent=zz')).statusCode, 404)
  assert.equal((await get('?agent=..%2Fs1')).statusCode, 400)
})

test('links the sessions on either side of a /clear', async (t) => {
  process.env.LOG_LEVEL = 'silent'
  const root = mkdtempSync(join(tmpdir(), 'clear-'))
  const at = (session: string, time: string, content: string) => JSON.stringify({ type: 'user', sessionId: session, timestamp: time, message: { content } })
  const answer = (session: string, time: string) => JSON.stringify({ type: 'assistant', sessionId: session, timestamp: time, message: { id: `r-${session}`, model: 'claude-opus-5', usage: { output_tokens: 1 } } })
  const write = (session: string, lines: string[], closedAt: string) => {
    writeFileSync(join(root, `${session}.jsonl`), `${lines.join('\n')}\n`)
    utimesSync(join(root, `${session}.jsonl`), new Date(closedAt), new Date(closedAt))
  }
  // The old session idled 5 min; its file was last written by the /clear at 10:05.
  write('old', [at('old', '2026-01-01T10:00:00Z', 'oi'), answer('old', '2026-01-01T10:00:01Z')], '2026-01-01T10:05:00.000Z')
  write('new', [at('new', '2026-01-01T10:05:00.100Z', '<command-name>/clear</command-name>\n<command-message>clear</command-message>'), at('new', '2026-01-01T10:05:10Z', 'de novo'), answer('new', '2026-01-01T10:05:11Z')], '2026-01-01T10:05:11Z')
  write('other', [at('other', '2026-01-01T10:04:00Z', 'outro terminal'), answer('other', '2026-01-01T10:04:01Z')], '2026-01-01T10:04:01Z')
  const usage = new UsageTracker(root, join(root, 'cache.json'))
  const app = createApp(onboardedDatabase(), usage)
  t.after(() => app.close())
  await app.ready()
  await usage.scan()
  const signup = await app.inject({
    method: 'POST', url: '/api/v1/auth/signup',
    payload: { name: 'Teste', email: 'a@b.co', password: 'senha-teste-123', avatarSeed: crypto.randomUUID() },
  })
  const cookie = signup.headers['set-cookie']!.toString().split(';')[0]
  const clear = async (session: string) => (await app.inject({ url: `/api/v1/usage/sessions/${session}`, headers: { cookie } })).json().clear

  assert.deepEqual(await clear('new'), { previous: 'old', startedAt: '2026-01-01T10:05:00.100Z' })
  assert.deepEqual(await clear('old'), { next: 'new', endedAt: '2026-01-01T10:05:00.000Z' })
  assert.deepEqual(await clear('other'), {})
})

test('stars, renames and unstars a session per user', async (t) => {
  process.env.LOG_LEVEL = 'silent'
  const root = mkdtempSync(join(tmpdir(), 'favorites-'))
  const app = createApp(onboardedDatabase(), new UsageTracker(root, join(root, 'cache.json')))
  t.after(() => app.close())
  await app.ready()
  const account = async (email: string) => {
    const signup = await app.inject({
      method: 'POST', url: '/api/v1/auth/signup',
      payload: { name: 'Teste', email, password: 'senha-teste-123', avatarSeed: crypto.randomUUID() },
    })
    const cookie = signup.headers['set-cookie']!.toString().split(';')[0]!
    return (method: 'GET' | 'PUT' | 'DELETE', id = '', payload?: object) =>
      app.inject({ method, url: `/api/v1/favorites${id && `/${id}`}`, headers: { cookie, origin: 'http://localhost:47832' }, payload })
  }
  const ana = await account('ana@b.co')
  const bia = await account('bia@b.co')
  const names = async (as: typeof ana) => (await as('GET')).json().favorites.map((row: { sessionId: string; name: string | null }) => [row.sessionId, row.name])

  await ana('PUT', 's1', { name: null })
  await ana('PUT', 's1', { name: '  Refatoração do login  ' })
  await ana('PUT', 's2', { name: '' })
  assert.deepEqual(await names(ana), [['s2', null], ['s1', 'Refatoração do login']])
  assert.deepEqual(await names(bia), [])
  await ana('DELETE', 's2')
  assert.deepEqual(await names(ana), [['s1', 'Refatoração do login']])
  assert.equal((await ana('PUT', 's1', { name: 'x'.repeat(121) })).statusCode, 400)
})

test('keeps each user\'s section order and hidden sections', async (t) => {
  process.env.LOG_LEVEL = 'silent'
  const root = mkdtempSync(join(tmpdir(), 'prefs-'))
  const app = createApp(onboardedDatabase(), new UsageTracker(root, join(root, 'cache.json')))
  t.after(() => app.close())
  await app.ready()
  const signup = await app.inject({
    method: 'POST', url: '/api/v1/auth/signup',
    payload: { name: 'Teste', email: 'a@b.co', password: 'senha-teste-123', avatarSeed: crypto.randomUUID() },
  })
  const cookie = signup.headers['set-cookie']!.toString().split(';')[0]
  const preferences = (method: 'GET' | 'PUT', payload?: object) => app.inject({ method, url: '/api/v1/preferences', headers: { cookie }, payload })

  assert.deepEqual((await preferences('GET')).json(), { sectionOrder: null, hiddenSections: null })
  await preferences('PUT', { sectionOrder: ['chat', 'hooks'], hiddenSections: ['hooks', 'chat'] })
  await preferences('PUT', { sectionOrder: ['hooks', 'chat'], hiddenSections: ['chat'] })
  assert.deepEqual((await preferences('GET')).json(), { sectionOrder: ['hooks', 'chat'], hiddenSections: ['chat'] })
  assert.equal((await preferences('PUT', { hiddenSections: [] })).statusCode, 400)
  assert.equal((await app.inject({ url: '/api/v1/preferences' })).statusCode, 401)
})

test('sums every session of a project', async (t) => {
  process.env.LOG_LEVEL = 'silent'
  const root = mkdtempSync(join(tmpdir(), 'projects-'))
  const answer = (session: string, id: string, cwd: string) => JSON.stringify({
    type: 'assistant', sessionId: session, cwd, timestamp: '2026-01-01T00:00:01Z',
    message: { id, model: 'claude-opus-5', usage: { input_tokens: 10, output_tokens: 1 }, content: [{ type: 'tool_use', name: 'Bash' }] },
  })
  writeFileSync(join(root, 'a.jsonl'), `${answer('a', 'r1', '/w/app')}\n`)
  writeFileSync(join(root, 'b.jsonl'), `${answer('b', 'r2', '/w/app')}\n`)
  writeFileSync(join(root, 'c.jsonl'), `${answer('c', 'r3', '/w/other')}\n`)
  const usage = new UsageTracker(root, join(root, 'cache.json'))
  const app = createApp(onboardedDatabase(), usage)
  t.after(() => app.close())
  await app.ready()
  await usage.scan()
  const signup = await app.inject({
    method: 'POST', url: '/api/v1/auth/signup',
    payload: { name: 'Teste', email: 'a@b.co', password: 'senha-teste-123', avatarSeed: crypto.randomUUID() },
  })
  const cookie = signup.headers['set-cookie']!.toString().split(';')[0]
  const get = (path: string) => app.inject({ url: `/api/v1/usage/projects?path=${encodeURIComponent(path)}`, headers: { cookie } })

  const project = (await get('/w/app')).json()
  assert.deepEqual([project.session.title, project.session.turns, project.session.input], ['app', 2, 20])
  assert.deepEqual(project.agents.map((agent: { id: string; turns: number }) => [agent.id, agent.turns]), [['main', 2]])
  assert.deepEqual(project.tools, [{ name: 'Bash', count: 2 }])
  assert.equal(project.timeline.length, 2)
  assert.equal((await get('/w/none')).statusCode, 404)
  const since = (from: string) => app.inject({ url: `/api/v1/usage/projects?path=%2Fw%2Fapp&from=${from}`, headers: { cookie } })
  assert.equal((await since('2025-12-31T00:00:00.000Z')).json().session.turns, 2)
  assert.equal((await since('2026-01-02T00:00:00.000Z')).statusCode, 404)

  const removed = await app.inject({ method: 'DELETE', url: `/api/v1/usage/projects?path=${encodeURIComponent('/w/app')}`, headers: { cookie } })
  assert.equal(removed.statusCode, 200)
  assert.equal((await get('/w/app')).statusCode, 404)
  assert.equal((await app.inject({ url: '/api/v1/usage/sessions/a', headers: { cookie } })).statusCode, 404)
  assert.deepEqual(usage.list().map((session) => session.id), ['c'])
})

test('manual mode reads and shows only the chosen folders, and can hide the chat', async (t) => {
  process.env.LOG_LEVEL = 'silent'
  const root = mkdtempSync(join(tmpdir(), 'privacy-'))
  const line = (session: string, cwd: string) => [
    JSON.stringify({ type: 'user', sessionId: session, cwd, timestamp: '2026-01-01T00:00:00Z', message: { content: 'segredo' } }),
    JSON.stringify({ type: 'assistant', sessionId: session, cwd, timestamp: '2026-01-01T00:00:01Z', message: { id: `r-${session}`, model: 'claude-opus-5', usage: { output_tokens: 1 } } }),
  ].join('\n')
  for (const [session, cwd] of [['a', '/w/app'], ['b', '/w/other']]) {
    mkdirSync(join(root, cwd.replace(/[^a-zA-Z0-9]/g, '-')))
    writeFileSync(join(root, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${session}.jsonl`), `${line(session, cwd)}\n`)
  }
  const usage = new UsageTracker(root, join(root, 'cache.json'))
  const app = createApp(onboardedDatabase(), usage)
  t.after(() => app.close())
  await app.ready()
  const signup = await app.inject({
    method: 'POST', url: '/api/v1/auth/signup',
    payload: { name: 'Teste', email: 'a@b.co', password: 'senha-teste-123', avatarSeed: crypto.randomUUID() },
  })
  const cookie = signup.headers['set-cookie']!.toString().split(';')[0]
  const saved = await app.inject({
    method: 'PUT', url: '/api/v1/privacy', headers: { cookie },
    payload: { mode: 'manual', projects: ['/w/app'], paused: false, hideChat: true, hidePaths: false },
  })
  assert.equal(saved.statusCode, 200)
  await usage.reset()

  assert.deepEqual(usage.list().map((session) => session.id), ['a'])
  const detail = (await app.inject({ url: '/api/v1/usage/sessions/a', headers: { cookie } })).json()
  assert.deepEqual(detail.messages, [])
  assert.ok(detail.timeline.every((point: { prompt: string }) => point.prompt === ''))
  assert.equal((await app.inject({ url: '/api/v1/usage/sessions/b', headers: { cookie } })).statusCode, 404)

  const folders = (await app.inject({ url: `/api/v1/folders?path=${encodeURIComponent(root)}`, headers: { cookie } })).json()
  assert.equal(folders.folders.length, 2)
  assert.equal((await app.inject({ url: '/api/v1/folders?path=relative', headers: { cookie } })).statusCode, 400)
})

test('clearing the history counts only what comes after, and syncing brings it back', async (t) => {
  process.env.LOG_LEVEL = 'silent'
  const root = mkdtempSync(join(tmpdir(), 'history-'))
  const file = join(root, 's1.jsonl')
  const answer = (id: string, at: string) => JSON.stringify({
    type: 'assistant', sessionId: 's1', cwd: '/w/app', timestamp: at,
    message: { id, model: 'claude-opus-5', usage: { input_tokens: 10, output_tokens: 1 } },
  })
  writeFileSync(file, `${answer('old', '2020-01-01T00:00:00.000Z')}\n`)
  const usage = new UsageTracker(root, join(root, 'cache.json'))
  const app = createApp(onboardedDatabase(), usage)
  t.after(() => app.close())
  await app.ready()
  await usage.scan()
  const signup = await app.inject({
    method: 'POST', url: '/api/v1/auth/signup',
    payload: { name: 'Teste', email: 'a@b.co', password: 'senha-teste-123', avatarSeed: crypto.randomUUID() },
  })
  const cookie = signup.headers['set-cookie']!.toString().split(';')[0]
  const session = () => app.inject({ url: '/api/v1/usage/sessions/s1', headers: { cookie } })
  const post = (url: string) => app.inject({ method: 'POST', url: `/api/v1/history/${url}`, headers: { cookie } })

  const cleared = (await post('clear')).json()
  assert.ok(cleared.since)
  assert.equal((await session()).statusCode, 404)

  appendFileSync(file, `${answer('new', new Date(Date.now() + 1000).toISOString())}\n`)
  await usage.scan()
  const recent = (await session()).json()
  assert.deepEqual([recent.session.turns, recent.session.input, recent.agents[0].turns], [1, 10, 1])

  assert.equal((await post('sync')).json().since, null)
  assert.equal((await session()).json().session.turns, 2)
})

test('deletes the account and its data only with the right password', async (t) => {
  process.env.LOG_LEVEL = 'silent'
  const root = mkdtempSync(join(tmpdir(), 'account-'))
  const db = onboardedDatabase()
  const app = createApp(db, new UsageTracker(root, join(root, 'cache.json')))
  t.after(() => app.close())
  await app.ready()
  const signup = await app.inject({
    method: 'POST', url: '/api/v1/auth/signup',
    payload: { name: 'Teste', email: 'a@b.co', password: 'senha-teste-123', avatarSeed: crypto.randomUUID() },
  })
  const cookie = signup.headers['set-cookie']!.toString().split(';')[0]
  await app.inject({ method: 'PUT', url: '/api/v1/preferences', headers: { cookie }, payload: { sectionOrder: ['a'], hiddenSections: [] } })
  const remove = (password: string) => app.inject({ method: 'DELETE', url: '/api/v1/account', headers: { cookie }, payload: { password } })

  assert.equal((await remove('errada')).statusCode, 403)
  assert.equal((await remove('senha-teste-123')).statusCode, 200)
  assert.equal((await app.inject({ url: '/api/v1/profile', headers: { cookie } })).statusCode, 401)
  for (const table of ['users', 'sessions', 'preferences', 'privacy']) {
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 0, table)
  }
})

test('opens the dashboard only once Claude Code history can be read', async (t) => {
  process.env.LOG_LEVEL = 'silent'
  const home = mkdtempSync(join(tmpdir(), 'onboarding-'))
  const root = join(home, 'projects')
  const usage = new UsageTracker(root, join(home, 'cache.json'))
  const app = createApp(openDatabase(':memory:'), usage)
  t.after(() => app.close())
  await app.ready()
  const signup = await app.inject({
    method: 'POST', url: '/api/v1/auth/signup',
    payload: { name: 'Teste', email: 'a@b.co', password: 'senha-teste-123', avatarSeed: crypto.randomUUID() },
  })
  assert.equal(signup.json().user.onboarded, false)
  const cookie = signup.headers['set-cookie']!.toString().split(';')[0]
  const status = async () => (await app.inject({ url: '/api/v1/claude/status', headers: { cookie } })).json()
  const finish = () => app.inject({ method: 'POST', url: '/api/v1/onboarding', headers: { cookie } })

  assert.equal((await status()).code, 'not-found')
  assert.equal((await finish()).statusCode, 409)
  assert.equal((await app.inject({ url: '/api/v1/usage/sessions/s1', headers: { cookie } })).statusCode, 403)

  mkdirSync(join(root, 'proj'), { recursive: true })
  assert.equal((await status()).code, 'empty')

  writeFileSync(join(root, 'proj', 's1.jsonl'), `${reply}\n`)
  assert.deepEqual(await status(), { ok: true, root, sessions: 1 })
  assert.match((await finish()).json().error.message, /privacidade/)
  const savePrivacy = (payload: object) => app.inject({ method: 'PUT', url: '/api/v1/privacy', headers: { cookie }, payload: { mode: 'auto', projects: [], paused: false, hideChat: false, hidePaths: false, ...payload } })
  await savePrivacy({ mode: 'manual' })
  assert.match((await finish()).json().error.message, /ao menos uma pasta/)
  await savePrivacy({})
  const done = await finish()
  assert.equal(done.statusCode, 200)
  assert.equal(done.json().user.onboarded, true)
  assert.equal((await app.inject({ url: '/api/v1/profile', headers: { cookie } })).json().user.onboarded, true)
})

test('forcing a refresh re-reads the history and needs a session', async (t) => {
  process.env.LOG_LEVEL = 'silent'
  const root = mkdtempSync(join(tmpdir(), 'refresh-'))
  const file = join(root, 's1.jsonl')
  writeFileSync(file, `${reply}\n`)
  const usage = new UsageTracker(root, join(root, 'cache.json'))
  const app = createApp(onboardedDatabase(), usage)
  t.after(() => app.close())
  await app.ready()
  await usage.scan()
  const signup = await app.inject({
    method: 'POST', url: '/api/v1/auth/signup',
    payload: { name: 'Teste', email: 'a@b.co', password: 'senha-teste-123', avatarSeed: crypto.randomUUID() },
  })
  const cookie = signup.headers['set-cookie']!.toString().split(';')[0]

  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/usage/refresh' })).statusCode, 401)

  const second = JSON.stringify({ type: 'assistant', sessionId: 's1', timestamp: '2026-01-01T00:00:02Z', message: { id: 'r2', model: 'claude-opus-5', usage: { output_tokens: 4 } } })
  appendFileSync(file, `${second}\n`)
  assert.equal(usage.get('s1')!.output, 1)

  const forced = await app.inject({ method: 'POST', url: '/api/v1/usage/refresh', headers: { cookie } })
  assert.deepEqual([forced.statusCode, forced.json()], [200, { ok: true }])
  assert.equal(usage.get('s1')!.output, 5)
})

test('keeps a deleted session in its project and a starred one whole', async (t) => {
  process.env.LOG_LEVEL = 'silent'
  process.env.MONITOR_PERSIST_MS = '5'
  t.after(() => delete process.env.MONITOR_PERSIST_MS)
  const root = mkdtempSync(join(tmpdir(), 'lost-'))
  const history = join(root, 'history')
  mkdirSync(history)
  const lines = (session: string) => [
    JSON.stringify({ type: 'user', sessionId: session, cwd: '/w/app', timestamp: '2026-01-01T00:00:00Z', message: { content: `oi ${session}` } }),
    JSON.stringify({ type: 'assistant', sessionId: session, cwd: '/w/app', timestamp: '2026-01-01T00:00:01Z', message: { id: `r-${session}`, model: 'claude-opus-5', usage: { input_tokens: 10, output_tokens: 1 }, content: [{ type: 'tool_use', name: 'Bash' }] } }),
  ].join('\n')
  writeFileSync(join(history, 'a.jsonl'), `${lines('a')}\n`)
  writeFileSync(join(history, 'b.jsonl'), `${lines('b')}\n`)
  const usage = new UsageTracker(history, join(root, 'cache.json'))
  const db = onboardedDatabase()
  const app = createApp(db, usage)
  t.after(() => app.close())
  await app.ready()
  await usage.scan()
  const signup = await app.inject({
    method: 'POST', url: '/api/v1/auth/signup',
    payload: { name: 'Teste', email: 'a@b.co', password: 'senha-teste-123', avatarSeed: crypto.randomUUID() },
  })
  const cookie = signup.headers['set-cookie']!.toString().split(';')[0]
  await app.inject({ method: 'PUT', url: '/api/v1/favorites/b', headers: { cookie, origin: 'http://localhost:47832' }, payload: { name: null } })
  const saved = () => (db.prepare('SELECT COUNT(*) AS n FROM session_summaries').get() as { n: number }).n === 2 && existsSync(join(root, 'favorites', 'b', 'b.jsonl'))
  for (let tries = 0; !saved(); tries++) {
    assert.ok(tries < 200, 'summaries and favorite copy never saved')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  rmSync(join(history, 'a.jsonl'))
  rmSync(join(history, 'b.jsonl'))
  await usage.scan()
  assert.deepEqual(usage.list().map((session) => [session.id, session.lost ?? false]).sort(), [['a', true], ['b', false]])

  const get = (url: string) => app.inject({ url: `/api/v1${url}`, headers: { cookie } })
  const project = (await get(`/usage/projects?path=${encodeURIComponent('/w/app')}`)).json()
  assert.deepEqual([project.session.turns, project.tools], [2, [{ name: 'Bash', count: 2 }]])
  const lost = (await get('/usage/sessions/a')).json()
  assert.deepEqual([lost.summary, lost.messages.length, lost.tools], [true, 0, [{ name: 'Bash', count: 1 }]])
  const starred = (await get('/usage/sessions/b')).json()
  assert.deepEqual([starred.summary, starred.messages[0].text], [undefined, 'oi b'])
})
