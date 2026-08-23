import nodemailer from 'nodemailer'

// GoDaddy Workspace / Professional Email (Titan) SMTP hosts
const configs = [
  { name: 'GoDaddy secureserver 587', host: 'smtpout.secureserver.net', port: 587, secure: false },
  { name: 'GoDaddy secureserver 465', host: 'smtpout.secureserver.net', port: 465, secure: true },
  { name: 'GoDaddy Titan 587', host: 'smtp.titan.email', port: 587, secure: false },
  { name: 'GoDaddy Titan 465', host: 'smtp.titan.email', port: 465, secure: true },
  { name: 'GoDaddy M365 587', host: 'smtp.office365.com', port: 587, secure: false },
]

// Hardcoded test values — not read from .env
const user = 'support@peptideopslogistics.com'
const pass = 'Rbcn0220+#'
const to = 'shariarhosain131529@gmail.com'
const from = 'Peptide Ops Logistics <support@peptideopslogistics.com>'

console.log('Testing SMTP for:', user)
console.log('Sending to:', to)

for (const cfg of configs) {
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user, pass },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
  })

  try {
    await transporter.verify()
    console.log('VERIFY OK:', cfg.name, `${cfg.host}:${cfg.port}`)

    const info = await transporter.sendMail({
      from,
      to,
      subject: 'SMTP test - Peptide Ops Logistics',
      text: `This is a test email to confirm SMTP is working. Sent at ${new Date().toISOString()}`,
      html: `<p>This is a <strong>test email</strong> to confirm SMTP is working.</p><p>Sent at ${new Date().toISOString()}</p>`,
    })

    console.log('SEND OK:', cfg.name, 'messageId=', info.messageId)
    console.log('WORKING_CONFIG:', JSON.stringify(cfg))
    process.exit(0)
  } catch (error) {
    console.log('FAIL:', cfg.name, error.message)
  }
}

process.exit(1)
