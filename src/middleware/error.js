import { HttpError } from '../lib/http-error.js'
import { env } from '../lib/env.js'

export function notFoundHandler(req, res) {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` })
}

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
export function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, details: err.details })
  }

  // Prisma unique-constraint violation
  if (err?.code === 'P2002') {
    const target = Array.isArray(err.meta?.target) ? err.meta.target.join(', ') : 'value'
    return res.status(409).json({ error: `That ${target} is already in use.` })
  }

  if (err?.code === 'P2025') {
    return res.status(404).json({ error: 'Not found.' })
  }

  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Payload too large.' })
  }

  console.error('[api] Unhandled error:', err)

  res.status(500).json({
    error: 'Something went wrong. Please try again.',
    ...(env.isProd ? {} : { detail: err?.message }),
  })
}
