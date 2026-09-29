import cookie from '@fastify/cookie'
import rateLimit from '@fastify/rate-limit'
import Fastify from 'fastify'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join, sep } from 'node:path'
import { ZodError } from 'zod'
import { isHub, registerAuthRoutes } from './auth.js'
import { openDatabase, type Database } from './database.js'
import { registerHubRoutes } from './hub.js'
import { resendMailer, type Mailer } from './mail.js'
import { registerPrivacyRoutes } from './privacy.js'
import { registerShareRoutes } from './shares.js'
import { registerUsageRoutes, UsageTracker } from './usage.js'

const dist = join(import.meta.dirname, '..', '..', 'dist')
const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}
// 47832 is the port of `make start`; the desktop app moves to another when it is taken, and the page's origin follows.
const localOrigins = () => [47832, process.env.PORT].filter(Boolean).flatMap((port) => [`http://localhost:${port}`, `http://127.0.0.1:${port}`])

export function createApp(db: Database = openDatabase(), usage = new UsageTracker(), mailer?: Mailer) {
  const hub = isHub()
  const allowedOrigins = new Set(hub ? [new URL(process.env.HUB_PUBLIC_URL ?? 'http://localhost:47832').origin] : localOrigins())
  const app = Fastify({
    // The hub sits behind a reverse proxy, and the rate limit needs the client's real IP.
    trustProxy: hub,
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: { paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'], censor: '«redigido»' },
    },
  })
  app.register(cookie)
  // SameSite=strict covers most CSRF; the origin check closes writes sent with a foreign Origin.
  app.addHook('preHandler', async (request, reply) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return
    const origin = request.headers.origin
    if (origin && !allowedOrigins.has(origin)) await reply.code(403).send({ error: { message: 'Origem não autorizada para esta ação.' } })
  })

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: { message: error.issues[0]?.message ?? 'Dados inválidos.' } })
    const statusCode = error instanceof Error && 'statusCode' in error ? Number(error.statusCode) : undefined
    if (statusCode === 429) return reply.code(429).send({ error: { message: 'Muitas ações em sequência. Aguarde um instante e tente novamente.' } })
    app.log.error(error)
    return reply.code(500).send({ error: { message: 'Ocorreu um erro inesperado.' } })
  })

  app.get('/health', async () => ({ status: 'ok', service: 'tokenlens' }))

  app.register(async (api) => {
    await api.register(rateLimit, { max: 240, timeWindow: '1 minute' })
    // Tells the page which app to render: the local monitor or the hub.
    api.get('/v1/meta', async () => ({ hub, publicShares: process.env.HUB_ALLOW_PUBLIC_SHARES !== 'false' }))
    const mail = mailer ?? resendMailer(app.log)
    registerAuthRoutes(api, db, mail)
    // The hub never reads a history folder: it only holds what local monitors send to it.
    if (hub) return registerHubRoutes(api, db, mail)
    const routes = registerUsageRoutes(api, db, usage)
    registerPrivacyRoutes(api, db, usage, routes.resend)
    registerShareRoutes(api, db, usage, routes)
  }, { prefix: '/api' })

  // Serves the built page, for `make start` and for the hub, so Vite is only needed in development.
  if (existsSync(join(dist, 'index.html'))) app.setNotFoundHandler(async (request, reply) => {
    const pathname = new URL(request.url, 'http://local').pathname
    const notFound = { error: { message: 'Rota não encontrada.' } }
    if (request.method !== 'GET' || pathname.startsWith('/api/')) return reply.code(404).send(notFound)
    let path: string
    try {
      path = join(dist, decodeURIComponent(pathname))
    } catch {
      return reply.code(400).send(notFound)
    }
    // Client routes like /s/<token> have no extension and all get the page.
    const file = path.startsWith(`${dist}${sep}`) && extname(path) ? path : join(dist, 'index.html')
    const body = await readFile(file).catch(() => undefined)
    if (!body) return reply.code(404).send(notFound)
    return reply.type(contentTypes[extname(file)] ?? 'application/octet-stream').send(body)
  })

  if (hub) return app

  app.addHook('onReady', async () => { usage.start(app.log) })

  app.addHook('onClose', async () => { await usage.stop() })

  return app
}
