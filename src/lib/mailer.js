import nodemailer from 'nodemailer'
import { env } from './env.js'

let transporter = null

function getTransporter() {
  if (transporter) return transporter
  if (!env.smtp.host) return null

  transporter = nodemailer.createTransport({
    host: env.smtp.host,
    port: env.smtp.port,
    secure: env.smtp.secure,
    auth: env.smtp.user ? { user: env.smtp.user, pass: env.smtp.pass } : undefined,
  })

  return transporter
}

/**
 * Sends an email, or logs it when SMTP is unconfigured. Delivery problems are
 * swallowed on purpose: a failed notification must never fail the request that
 * triggered it.
 */
export async function sendMail({ to, subject, html, text }) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean)
  if (!recipients.length) return { sent: false, reason: 'no-recipient' }

  const mailer = getTransporter()
  if (!mailer) {
    console.log(`[mail] SMTP not configured - would send "${subject}" to ${recipients.join(', ')}`)
    return { sent: false, reason: 'smtp-not-configured' }
  }

  try {
    await mailer.sendMail({
      from: env.smtp.from,
      to: recipients.join(', '),
      subject,
      text: text || stripHtml(html),
      html,
    })
    return { sent: true }
  } catch (error) {
    console.error(`[mail] failed to send "${subject}":`, error.message)
    return { sent: false, reason: error.message }
  }
}

function stripHtml(html = '') {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h1|h2|h3)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
