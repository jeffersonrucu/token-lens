import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openDatabase } from './database.js'
import { DEFAULT_PRIVACY, historyFolder, readScope, shows } from './privacy.js'
import type { SessionUsage } from './usage.js'

const session = (project: string | null) => ({ project }) as SessionUsage

test('manual mode shows the chosen folders and their subfolders only', () => {
  const manual = { ...DEFAULT_PRIVACY, mode: 'manual' as const, projects: ['/home/dev/app'] }
  assert.equal(shows(DEFAULT_PRIVACY, session(null)), true)
  assert.equal(shows(manual, session('/home/dev/app')), true)
  assert.equal(shows(manual, session('/home/dev/app/api')), true)
  assert.equal(shows(manual, session('/home/dev/app-old')), false)
  assert.equal(shows(manual, session(null)), false)
})

test('reads only the folders active accounts need', () => {
  assert.equal(historyFolder('/home/dev/my_app.v2'), '-home-dev-my-app-v2')
  const db = openDatabase(':memory:')
  assert.equal(readScope(db), null)
  const addUser = (id: string, settings: object) => {
    db.prepare("INSERT INTO users (id, name, email, password_hash, avatar_seed, created_at) VALUES (?, 'x', ?, 'x', 'x', 'x')").run(id, `${id}@e.co`)
    db.prepare('INSERT INTO privacy (user_id, settings) VALUES (?, ?)').run(id, JSON.stringify(settings))
  }
  addUser('a', { mode: 'manual', projects: ['/home/dev/app'] })
  addUser('b', { mode: 'auto', paused: true })
  assert.deepEqual(readScope(db), ['-home-dev-app'])
  addUser('c', { mode: 'auto' })
  assert.equal(readScope(db), null)
})
