import type { FastifyBaseLogger } from 'fastify'

export type Mailer = (to: string, subject: string, text: string) => Promise<void>

/** Sends through Resend's HTTP API; without RESEND_API_KEY it only logs, so the hub runs in development. */
export function resendMailer(log: FastifyBaseLogger): Mailer {
  return async (to, subject, text) => {
    const key = process.env.RESEND_API_KEY
    if (!key) {
      log.warn({ to, subject, text }, 'RESEND_API_KEY ausente: e-mail não enviado')
      return
    }
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: process.env.HUB_EMAIL_FROM, to: [to], subject, text }),
    })
    if (!response.ok) throw new Error(`Resend respondeu ${response.status}: ${await response.text()}`)
  }
}
