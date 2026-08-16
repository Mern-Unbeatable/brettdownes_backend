import { Router } from 'express'
import { z } from 'zod'
import { requireAuth } from '../../middleware/auth.js'
import { validate } from '../../middleware/validate.js'
import { buildParcel, createShipmentWithRates, easypostEnabled } from '../../lib/easypost.js'
import { getSettings } from '../settings/settings.service.js'
import { resolveCart } from '../orders/cart.service.js'

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

const router = Router()

router.get('/status', requireAuth, (req, res) => {
  res.json({ enabled: easypostEnabled() })
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
