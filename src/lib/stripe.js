import Stripe from 'stripe'
import { env } from './env.js'
import { HttpError } from './http-error.js'

let client = null

export function stripeEnabled() {
  return Boolean(env.stripe.secretKey)
}

export function getStripe() {
  if (!stripeEnabled()) {
    throw new HttpError(
      503,
      'Card payments are not available right now. Please choose warehouse pickup or contact support.',
    )
  }
  if (!client) {
    client = new Stripe(env.stripe.secretKey, {
      ...(env.stripe.apiHost ? { host: env.stripe.apiHost } : {}),
      ...(env.stripe.apiPort ? { port: env.stripe.apiPort } : {}),
      ...(env.stripe.apiProtocol ? { protocol: env.stripe.apiProtocol } : {}),
    })
  }
  return client
}

/**
 * Stripe deliberately receives no product information: only an amount, a
 * currency, our internal order id and a neutral descriptor. Nothing in the
 * payload reveals what was purchased.
 */
export function sanitizeDescriptor(value) {
  return String(value || '')
    // Stripe rejects < > \ ' " * in statement descriptors.
    .replace(/[<>\\'"*]/g, '')
    .trim()
    .slice(0, 22)
}
