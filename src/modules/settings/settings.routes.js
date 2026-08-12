import { Router } from 'express'
import { z } from 'zod'
import { env } from '../../lib/env.js'
import { requireAdmin } from '../../middleware/auth.js'
import { validate } from '../../middleware/validate.js'
import { getSettings, updateSettings } from './settings.service.js'
import { toPublicSettings } from './settings.defaults.js'

const addressBlock = z.object({
  name: z.string().trim().max(120).optional(),
  company: z.string().trim().max(120).optional(),
  street1: z.string().trim().max(200).optional(),
  street2: z.string().trim().max(200).optional(),
  city: z.string().trim().max(120).optional(),
  state: z.string().trim().max(60).optional(),
  zip: z.string().trim().max(20).optional(),
  country: z.string().trim().max(2).optional(),
  phone: z.string().trim().max(40).optional(),
  email: z.string().trim().max(160).optional(),
})

const settingsPatchSchema = z.object({
  autoApproval: z.boolean().optional(),
  adminNotifyEmails: z.array(z.string().trim().email()).max(10).optional(),
  notifyNewRegistration: z.boolean().optional(),
  notifyNewOrder: z.boolean().optional(),
  deliveryNote: z.string().trim().max(4000).optional(),
  pickupNote: z.string().trim().max(4000).optional(),
  paymentDescriptorNote: z.string().trim().max(1000).optional(),
  // Stripe truncates statement descriptors beyond 22 characters.
  statementDescriptor: z.string().trim().max(22).optional(),
  shipFrom: addressBlock.optional(),
  pickupAddress: z
    .object({
      name: z.string().trim().max(120).optional(),
      lines: z.array(z.string().trim().max(160)).max(6).optional(),
    })
    .optional(),
  pickupLocations: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(80).optional(),
        name: z.string().trim().min(1, 'Location name is required.').max(120),
        lines: z.array(z.string().trim().max(160)).max(6).default([]),
      }),
    )
    .min(1, 'Add at least one pickup location.')
    .max(12)
    .optional(),
  defaultParcel: z
    .object({
      lengthIn: z.coerce.number().min(1).max(108).optional(),
      widthIn: z.coerce.number().min(1).max(108).optional(),
      heightIn: z.coerce.number().min(1).max(108).optional(),
      minWeightOz: z.coerce.number().min(0.1).max(1120).optional(),
    })
    .optional(),
  handlingFeeCents: z.coerce.number().int().min(0).max(100_000).optional(),
  freeShippingThresholdCents: z.coerce.number().int().min(0).max(10_000_000).optional(),
})

const router = Router()

router.get('/public', async (req, res) => {
  const settings = await getSettings()
  res.json({
    settings: toPublicSettings(settings, {
      stripePublishableKey: env.stripe.publishableKey,
      stripeEnabled: Boolean(env.stripe.secretKey),
      shippingEnabled: Boolean(env.easypost.apiKey),
    }),
  })
})

router.get('/', requireAdmin, async (req, res) => {
  const settings = await getSettings()
  res.json({
    settings,
    integrations: {
      stripeConfigured: Boolean(env.stripe.secretKey),
      easypostConfigured: Boolean(env.easypost.apiKey),
      smtpConfigured: Boolean(env.smtp.host),
    },
  })
})

router.patch('/', requireAdmin, validate(settingsPatchSchema), async (req, res) => {
  const settings = await updateSettings(req.body)
  res.json({ settings })
})

export default router
