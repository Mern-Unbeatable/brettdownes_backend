import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import { env } from './env.js'

export function signSessionToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn,
  })
}

export function verifySessionToken(token) {
  try {
    return jwt.verify(token, env.jwtSecret)
  } catch {
    return null
  }
}

const cookieBase = {
  httpOnly: true,
  secure: env.cookieSecure,
  sameSite: env.cookieSameSite,
  path: '/',
  ...(env.cookieDomain ? { domain: env.cookieDomain } : {}),
}

export function setSessionCookie(res, token) {
  res.cookie(env.cookieName, token, {
    ...cookieBase,
    maxAge: 1000 * 60 * 60 * 24 * 7,
  })
}

export function clearSessionCookie(res) {
  res.clearCookie(env.cookieName, cookieBase)
}

/** Returns the raw token to email and the hash to persist. */
export function createResetToken() {
  const raw = crypto.randomBytes(32).toString('hex')
  const hash = crypto.createHash('sha256').update(raw).digest('hex')
  return { raw, hash }
}

export function hashResetToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex')
}

/** 6-digit signup OTP; store only the hash. */
export function createSignupOtp() {
  const raw = String(crypto.randomInt(100000, 1000000))
  const hash = crypto.createHash('sha256').update(raw).digest('hex')
  return { raw, hash }
}

export function hashSignupOtp(raw) {
  return crypto.createHash('sha256').update(String(raw).trim()).digest('hex')
}
