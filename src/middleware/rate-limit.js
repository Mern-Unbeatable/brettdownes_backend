import { HttpError } from '../lib/http-error.js'

/**
 * Small in-memory throttle for credential endpoints. Good enough for a
 * single-instance deployment; swap for Redis if the API is ever scaled out.
 */
export function rateLimit({ windowMs = 60_000, max = 10, message } = {}) {
  const hits = new Map()

  const sweep = setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key)
    }
  }, windowMs)
  sweep.unref?.()

  return (req, res, next) => {
    const key = req.ip || 'unknown'
    const now = Date.now()
    const entry = hits.get(key)

    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs })
      return next()
    }

    entry.count += 1
    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000)
      res.setHeader('Retry-After', retryAfter)
      return next(
        new HttpError(429, message || `Too many attempts. Try again in ${retryAfter} seconds.`),
      )
    }

    next()
  }
}
