import { prisma } from '../lib/prisma.js'
import { env } from '../lib/env.js'
import { verifySessionToken } from '../lib/tokens.js'
import { forbidden, unauthorized } from '../lib/http-error.js'

const PUBLIC_USER_FIELDS = {
  id: true,
  email: true,
  name: true,
  company: true,
  phone: true,
  researchFramework: true,
  heardAboutUs: true,
  creditCents: true,
  role: true,
  status: true,
  createdAt: true,
}

/** Short in-memory cache — remote Postgres RTT is ~300–1100ms per lookup. */
const USER_CACHE_TTL_MS = 60_000
const userCache = new Map()

function readToken(req) {
  const fromCookie = req.cookies?.[env.cookieName]
  if (fromCookie) return fromCookie
  const header = req.headers.authorization
  if (header?.startsWith('Bearer ')) return header.slice(7)
  return null
}

export function invalidateUserCache(userId) {
  if (userId) userCache.delete(userId)
  else userCache.clear()
}

async function loadActiveUser(userId) {
  const cached = userCache.get(userId)
  if (cached && cached.expiresAt > Date.now()) return cached.user

  const user = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: PUBLIC_USER_FIELDS,
  })

  if (user && user.status === 'ACTIVE') {
    userCache.set(userId, { user, expiresAt: Date.now() + USER_CACHE_TTL_MS })
    return user
  }

  userCache.delete(userId)
  return null
}

/** Populates req.user when a valid session exists; never rejects. */
export async function attachUser(req, res, next) {
  const token = readToken(req)
  if (!token) return next()

  const payload = verifySessionToken(token)
  if (!payload?.sub) return next()

  try {
    const user = await loadActiveUser(payload.sub)
    if (user) req.user = user
  } catch (error) {
    return next(error)
  }

  next()
}

export function requireAuth(req, res, next) {
  if (!req.user) return next(unauthorized())
  next()
}

export function requireAdmin(req, res, next) {
  if (!req.user) return next(unauthorized())
  if (req.user.role !== 'ADMIN') return next(forbidden('Admin access required.'))
  next()
}

export { PUBLIC_USER_FIELDS }
