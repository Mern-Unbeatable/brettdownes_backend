import 'dotenv/config'

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback
  return value === 'true' || value === '1'
}

function int(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function list(value) {
  return String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

const nodeEnv = process.env.NODE_ENV || 'development'
const isProd = nodeEnv === 'production'

export const env = {
  nodeEnv,
  isProd,
  port: int(process.env.PORT, 4000),
  clientOrigins: list(process.env.CLIENT_ORIGINS || 'http://localhost:5173'),
  clientUrl: process.env.CLIENT_URL || 'http://localhost:5173',
  apiUrl: process.env.API_URL || `http://localhost:${int(process.env.PORT, 4000)}`,

  databaseUrl: process.env.DATABASE_URL,

  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  cookieName: process.env.COOKIE_NAME || 'peptide_session',
  cookieSecure: bool(process.env.COOKIE_SECURE, isProd),
  cookieSameSite: process.env.COOKIE_SAMESITE || 'lax',
  cookieDomain: process.env.COOKIE_DOMAIN || undefined,

  seedAdmin: {
    email: process.env.SEED_ADMIN_EMAIL || 'admin@peptideops.com',
    password: process.env.SEED_ADMIN_PASSWORD || 'ChangeMe123!',
    name: process.env.SEED_ADMIN_NAME || 'Peptide Ops Admin',
  },

  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
    // Point at stripe-mock instead of the live API. Never set in production.
    apiHost: process.env.STRIPE_API_HOST || '',
    apiPort: process.env.STRIPE_API_PORT ? int(process.env.STRIPE_API_PORT, 443) : undefined,
    apiProtocol: process.env.STRIPE_API_PROTOCOL || '',
  },

  easypost: {
    // The test key keeps development from buying real postage.
    apiKey: isProd
      ? process.env.EASYPOST_API_KEY || ''
      : process.env.EASYPOST_TEST_API_KEY || process.env.EASYPOST_API_KEY || '',
    baseUrl: process.env.EASYPOST_BASE_URL || '',
  },

  smtp: {
    host: process.env.SMTP_HOST || '',
    port: int(process.env.SMTP_PORT, 587),
    secure: bool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || 'Peptide Ops Logistics <no-reply@peptideopslogistics.com>',
  },

  maxUploadBytes: int(process.env.MAX_UPLOAD_MB, 5) * 1024 * 1024,
}

const required = [['DATABASE_URL', env.databaseUrl], ['JWT_SECRET', env.jwtSecret]]
const missing = required.filter(([, value]) => !value).map(([key]) => key)

if (missing.length) {
  throw new Error(
    `Missing required environment variable(s): ${missing.join(', ')}. Copy .env.example to .env and fill them in.`,
  )
}

if (isProd && env.jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters in production.')
}
