import { existsSync } from 'node:fs'

if (existsSync('.env')) process.loadEnvFile('.env')

import { createApp } from './app.js'

// Without it the hub rejects every write as cross-origin and mails links with no host.
if (process.env.MODE === 'hub' && !process.env.HUB_PUBLIC_URL) throw new Error('MODE=hub exige HUB_PUBLIC_URL no .env')

const app = createApp()
if (process.env.MODE === 'hub' && !process.env.RESEND_API_KEY) app.log.warn('RESEND_API_KEY ausente: e-mails e códigos vão só para o log')
await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 47831) })

// Closing runs the onClose hooks, which write the usage cache before exit.
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void app.close().then(() => process.exit(0)))
