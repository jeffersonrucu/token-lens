import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, Menu, shell } from 'electron'
import { createApp } from '../build/server/app.js'
import { openDatabase } from '../build/server/database.js'
import { defaultSources, UsageTracker } from '../build/server/usage.js'

const port = Number(process.env.PORT ?? 47832)
const settingsPath = join(homedir(), '.tokenlens', 'desktop.json')
let url = `http://127.0.0.1:${port}`
let server

function readSettings() {
  try {
    return JSON.parse(readFileSync(settingsPath, 'utf8'))
  } catch {
    return {}
  }
}

function writeSettings(settings) {
  mkdirSync(join(homedir(), '.tokenlens'), { recursive: true })
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`)
}

// On Windows the agents usually run inside WSL, where the history stays in the distro's home.
const wslSources = (home) => [
  { harness: 'claude', root: `${home}\\.claude\\projects` },
  { harness: 'codex', root: `${home}\\.codex\\sessions` },
  { harness: 'pi', root: `${home}\\.pi\\agent\\sessions` },
]

// Resolving a home starts the distro, so only the ones that may hold a history are asked, and the answer is cached.
function findDistros() {
  if (process.platform !== 'win32') return []
  const wsl = (args, encoding) => execFileSync('wsl.exe', args, { encoding, timeout: 20_000 })
  let names
  try {
    names = wsl(['-l', '-q'], 'utf16le').split('\n').map((name) => name.trim())
  } catch {
    return []
  }
  const found = []
  for (const name of names.filter((name) => name && !name.startsWith('docker-desktop'))) {
    try {
      const home = wsl(['-d', name, '--exec', 'sh', '-c', 'wslpath -w "$HOME"'], 'utf8').trim()
      if (home.startsWith('\\\\') && wslSources(home).some(({ root }) => existsSync(root))) found.push({ name, home })
    } catch {
      // A distro that will not start has no history to read either.
    }
  }
  return found
}

/** Windows, one WSL distro or everything at once; asked once and kept in desktop.json. */
function chooseHistory(ask) {
  const settings = readSettings()
  if (!ask && settings.history) return settings
  const distros = findDistros()
  if (!ask && !distros.length) return { history: 'windows', distros }
  const labels = ['Tudo', 'Só o Windows', ...distros.map(({ name }) => `WSL: ${name}`)]
  const chosen = dialog.showMessageBoxSync({
    type: 'question',
    buttons: labels,
    defaultId: 0,
    cancelId: 0,
    title: 'TokenLens',
    message: 'Onde estão as sessões dos agentes?',
    detail: 'O Claude Code, o Codex e o pi gravam na home de quem os executa. Dá para trocar depois no menu Sessões.',
  })
  const history = chosen === 0 ? 'all' : chosen === 1 ? 'windows' : distros[chosen - 2].name
  const settingsToKeep = { history, distros }
  writeSettings(settingsToKeep)
  return settingsToKeep
}

function sourcesFor({ history, distros = [] }) {
  if (history === 'windows') return defaultSources()
  const chosen = history === 'all' ? distros : distros.filter(({ name }) => name === history)
  const wsl = chosen.flatMap(({ home }) => wslSources(home))
  return history === 'all' ? [...defaultSources(), ...wsl] : wsl
}

// Windows reserves whole port ranges around 47832 (WSL's relay, Hyper-V), so after a few neighbours it takes any free port.
function freePort(candidate, tries = 0) {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', (error) => (error.code === 'EADDRINUSE' ? resolve(freePort(tries < 8 ? candidate + 1 : 0, tries + 1)) : reject(error)))
    probe.listen(candidate, '127.0.0.1', () => {
      const { port: free } = probe.address()
      probe.close(() => resolve(free))
    })
  })
}

// A monitor already started with `make up` owns the port: show that one instead of a second server.
async function serve() {
  const up = await fetch(`${url}/health`).then((response) => response.ok).catch(() => false)
  if (up) return
  const chosen = await freePort(port)
  // The API reads it to accept the page's origin, which is this same port.
  process.env.PORT = String(chosen)
  url = `http://127.0.0.1:${chosen}`
  server = createApp(openDatabase(), new UsageTracker(sourcesFor(chooseHistory(false))))
  await server.listen({ host: '127.0.0.1', port: chosen })
}

async function open() {
  Menu.setApplicationMenu(menu)
  await serve()
  const window = new BrowserWindow({ width: 1360, height: 900, backgroundColor: '#14161c', title: 'TokenLens' })
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target)
    return { action: 'deny' }
  })
  await window.loadURL(url)
}

// Changing the answer changes the folders the server reads, which it only does at startup.
const sessionsMenu = process.platform === 'win32' ? [{
  label: 'Sessões',
  submenu: [
    {
      label: 'Trocar origem…',
      click: () => {
        chooseHistory(true)
        app.relaunch()
        app.exit(0)
      },
    },
    { type: 'separator' },
    { role: 'quit', label: 'Sair' },
  ],
}] : []

const menu = Menu.buildFromTemplate([
  ...sessionsMenu,
  { label: 'Exibir', submenu: [{ role: 'reload', label: 'Recarregar' }, { role: 'toggleDevTools', label: 'Ferramentas' }, { type: 'separator' }, { role: 'resetZoom', label: 'Zoom normal' }, { role: 'zoomIn', label: 'Mais zoom' }, { role: 'zoomOut', label: 'Menos zoom' }] },
])

// A packaged app has no terminal: a failure to start would leave only a blank window.
function report(error) {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
  try {
    mkdirSync(join(homedir(), '.tokenlens'), { recursive: true })
    appendFileSync(join(homedir(), '.tokenlens', 'desktop.log'), `${new Date().toISOString()} ${message}\n`)
  } catch {
    // Nothing to do if even the log cannot be written.
  }
  dialog.showErrorBox('TokenLens', message)
  app.exit(1)
}

// Only one window, and a second launch focuses it instead of fighting for the port.
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
  app.whenReady().then(open).catch(report)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) open().catch(report)
  })
  app.on('window-all-closed', () => app.quit())
  // Closing the Fastify app runs its onClose hooks, which write the usage cache before exit.
  let closing = false
  app.on('before-quit', (event) => {
    if (closing || !server) return
    closing = true
    event.preventDefault()
    server.close().finally(() => app.quit())
  })
}
