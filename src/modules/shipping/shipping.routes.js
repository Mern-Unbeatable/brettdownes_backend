import { Router } from 'express'
import { z } from 'zod'
import { env } from '../../lib/env.js'
import { prisma } from '../../lib/prisma.js'
import { unauthorized } from '../../lib/http-error.js'
import { requireAuth } from '../../middleware/auth.js'
import { validate } from '../../middleware/validate.js'
import {
  buildParcel,
  createShipmentWithRates,
  easypostEnabled,
  fetchTrackerStatus,
} from '../../lib/easypost.js'
import { getSettings } from '../settings/settings.service.js'
import { resolveCart } from '../orders/cart.service.js'
import { applyTrackerUpdate } from '../orders/tracking.service.js'

const ratesSchema = z.object({
  items: z
    .array(
      z.object({
        variantId: z.string().min(1),
        qty: z.coerce.number().int().min(1).max(999),
      }),
    )
    .min(1, 'Your cart is empty.'),
  address: z.object({
    name: z.string().trim().max(120).optional(),
    line1: z.string().trim().min(1, 'Street address is required.').max(200),
    line2: z.string().trim().max(200).optional().or(z.literal('')),
    city: z.string().trim().min(1, 'City is required.').max(120),
    state: z.string().trim().min(1, 'State is required.').max(60),
    zip: z.string().trim().min(3, 'ZIP is required.').max(20),
    country: z.string().trim().length(2).default('US'),
    phone: z.string().trim().max(40).optional().or(z.literal('')),
  }),
})

function assertWebhookSecret(req) {
  const expected = env.easypost.webhookSecret
  if (!expected) return
  const provided =
    req.query.secret ||
    req.get('x-easypost-webhook-secret') ||
    req.get('x-webhook-secret') ||
    ''
  if (provided !== expected) throw unauthorized('Invalid webhook secret.')
}

function extractTracker(body) {
  if (!body || typeof body !== 'object') return null
  const description = String(body.description || '')
  const result = body.result && typeof body.result === 'object' ? body.result : null

  if (result && (result.object === 'Tracker' || result.tracking_code)) {
    return result
  }
  if (body.object === 'Tracker' || body.tracking_code) {
    return body
  }
  if (description.startsWith('tracker.') && result) {
    return result
  }
  return null
}

const router = Router()

router.get('/status', requireAuth, (req, res) => {
  res.json({ enabled: easypostEnabled() })
})

/**
 * EasyPost tracker webhook — when the carrier marks a package delivered,
 * the matching order flips to DELIVERED automatically.
 *
 * Configure in EasyPost dashboard:
 *   POST {API_URL}/api/shipping/easypost/webhook?secret={EASYPOST_WEBHOOK_SECRET}
 * Subscribe to tracker.updated (and optionally tracker.created).
 */
router.post('/easypost/webhook', async (req, res) => {
  assertWebhookSecret(req)

  const tracker = extractTracker(req.body)
  if (!tracker?.tracking_code) {
    return res.json({ ok: true, ignored: true, reason: 'not-a-tracker-event' })
  }

  const result = await applyTrackerUpdate({
    trackingCode: tracker.tracking_code,
    trackerStatus: tracker.status,
    trackingUrl: tracker.public_url || null,
    carrier: tracker.carrier || null,
  })

  res.json({ ok: true, ...result })
})

/**
 * Poll EasyPost for open shipped orders and apply delivered status.
 * Useful as a backup when webhooks were missed.
 * Auth: EASYPOST_WEBHOOK_SECRET query/header, or an admin session.
 */
router.post('/easypost/sync-tracking', async (req, res, next) => {
  try {
    const expected = env.easypost.webhookSecret
    const provided =
      req.query.secret ||
      req.get('x-easypost-webhook-secret') ||
      req.get('x-webhook-secret') ||
      ''

    const secretOk = expected && provided === expected
    const adminOk = req.user?.role === 'ADMIN'
    if (!secretOk && !adminOk) {
      throw unauthorized('Admin session or webhook secret required.')
    }

    if (!easypostEnabled()) {
      return res.json({ ok: true, synced: 0, message: 'EasyPost is not configured.' })
    }

    const orders = await prisma.order.findMany({
      where: {
        fulfillment: 'DELIVERY',
        status: { in: ['PROCESSING', 'SHIPPED'] },
        trackingCode: { not: null },
      },
      select: {
        id: true,
        trackingCode: true,
        carrier: true,
      },
      take: 50,
      orderBy: { shippedAt: 'asc' },
    })

    const results = []
    for (const order of orders) {
      try {
        const tracker = await fetchTrackerStatus({
          trackingCode: order.trackingCode,
          carrier: order.carrier || undefined,
        })
        const applied = await applyTrackerUpdate({
          trackingCode: tracker.trackingCode,
          trackerStatus: tracker.status,
          trackingUrl: tracker.trackingUrl,
          carrier: tracker.carrier,
        })
        results.push({ orderId: order.id, trackerStatus: tracker.status, ...applied })
      } catch (error) {
        results.push({
          orderId: order.id,
          updated: false,
          reason: 'tracker-error',
          message: error.message,
        })
      }
    }

    res.json({
      ok: true,
      checked: results.length,
      updated: results.filter((row) => row.updated).length,
      results,
    })
  } catch (error) {
    next(error)
  }
})

router.post('/rates', requireAuth, validate(ratesSchema), async (req, res) => {
  const { items: lines, address } = req.body
  const { items, subtotalCents } = await resolveCart(lines)
  const settings = await getSettings()

  const parcel = buildParcel(items)

  const { shipmentId, rates } = await createShipmentWithRates({
    toAddress: {
      name: address.name || req.user.name,
      street1: address.line1,
      street2: address.line2 || undefined,
      city: address.city,
      state: address.state,
      zip: address.zip,
      country: address.country,
      phone: address.phone || req.user.phone || undefined,
      email: req.user.email,
    },
    fromAddress: settings.shipFrom,
    parcel,
  })

  const threshold = settings.freeShippingThresholdCents
  const qualifiesFree = threshold > 0 && subtotalCents >= threshold

  res.json({
    shipmentId,
    parcel,
    freeShipping: qualifiesFree,
    rates: rates.map((rate) => ({
      ...rate,
      // Handling is folded into the displayed price so the total always matches.
      amountCents: qualifiesFree ? 0 : rate.amountCents + settings.handlingFeeCents,
    })),
  })
})

export default router
