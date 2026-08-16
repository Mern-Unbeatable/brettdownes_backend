import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { notFound } from '../../lib/http-error.js'
import { requireAdmin, requireAuth } from '../../middleware/auth.js'
import { validate } from '../../middleware/validate.js'
import { resolveCart } from '../orders/cart.service.js'
import {
  calculateCouponDiscount,
  getActiveDiscountTiers,
  serializeDiscountTier,
} from '../orders/discount.service.js'

const tierSchema = z.object({
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().default(true),
  scope: z.enum(['ORDER', 'KIT']),
  percent: z.coerce.number().int().min(1).max(90),
  minSubtotalCents: z.coerce.number().int().min(0).max(100_000_000),
})

const couponSchema = z
  .object({
    code: z.string().trim().min(2).max(40).regex(/^[A-Za-z0-9_-]+$/),
    description: z.string().trim().max(200).default(''),
    enabled: z.boolean().default(true),
    discountType: z.enum(['PERCENT', 'FIXED']),
    discountValue: z.coerce.number().int().min(1).max(100_000_000),
    appliesTo: z.enum(['ALL', 'SELECTED']),
    productIds: z.array(z.string().uuid()).max(500).default([]),
    minSubtotalCents: z.coerce.number().int().min(0).max(100_000_000).default(0),
    usageLimit: z.coerce.number().int().min(1).max(10_000_000).nullable().optional(),
    startsAt: z.coerce.date().nullable().optional(),
    expiresAt: z.coerce.date().nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.discountType === 'PERCENT' && value.discountValue > 100) {
      ctx.addIssue({ code: 'custom', path: ['discountValue'], message: 'Percent cannot exceed 100.' })
    }
    if (value.appliesTo === 'SELECTED' && !value.productIds.length) {
      ctx.addIssue({ code: 'custom', path: ['productIds'], message: 'Select at least one product.' })
    }
    if (value.startsAt && value.expiresAt && value.expiresAt <= value.startsAt) {
      ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: 'End date must be after start date.' })
    }
  })

const validateCouponSchema = z.object({
  code: z.string().trim().min(1).max(40),
  items: z.array(z.object({ variantId: z.string().min(1), qty: z.coerce.number().int().min(1) })).min(1),
})

function serializeCoupon(coupon) {
  return {
    ...coupon,
    productIds: (coupon.products || []).map((entry) => entry.productId),
    products: undefined,
  }
}

const router = Router()

router.get('/public', requireAuth, async (req, res) => {
  const tiers = await getActiveDiscountTiers()
  res.json({ tiers: tiers.map(serializeDiscountTier) })
})

router.post('/validate-coupon', requireAuth, validate(validateCouponSchema), async (req, res) => {
  const { items } = await resolveCart(req.body.items)
  const result = await calculateCouponDiscount(items, req.body.code)
  res.json({ coupon: result })
})

router.use('/admin', requireAdmin)

router.get('/admin', async (req, res) => {
  const [tiers, coupons] = await Promise.all([
    prisma.discountTier.findMany({ orderBy: [{ minSubtotalCents: 'asc' }, { createdAt: 'asc' }] }),
    prisma.coupon.findMany({
      include: { products: { select: { productId: true } } },
      orderBy: { createdAt: 'desc' },
    }),
  ])
  res.json({ tiers: tiers.map(serializeDiscountTier), coupons: coupons.map(serializeCoupon) })
})

router.post('/admin/tiers', validate(tierSchema), async (req, res) => {
  const tier = await prisma.discountTier.create({ data: req.body })
  res.status(201).json({ tier: serializeDiscountTier(tier) })
})

router.patch('/admin/tiers/:id', validate(tierSchema), async (req, res) => {
  const existing = await prisma.discountTier.findUnique({ where: { id: req.params.id } })
  if (!existing) throw notFound('Discount tier not found.')
  const tier = await prisma.discountTier.update({ where: { id: existing.id }, data: req.body })
  res.json({ tier: serializeDiscountTier(tier) })
})

router.delete('/admin/tiers/:id', async (req, res) => {
  const existing = await prisma.discountTier.findUnique({ where: { id: req.params.id } })
  if (!existing) throw notFound('Discount tier not found.')
  await prisma.discountTier.delete({ where: { id: existing.id } })
  res.json({ ok: true })
})

function couponData(body) {
  const { productIds, code, ...rest } = body
  return {
    ...rest,
    code: code.toUpperCase(),
    products:
      body.appliesTo === 'SELECTED'
        ? { create: productIds.map((productId) => ({ productId })) }
        : undefined,
  }
}

router.post('/admin/coupons', validate(couponSchema), async (req, res) => {
  const coupon = await prisma.coupon.create({
    data: couponData(req.body),
    include: { products: { select: { productId: true } } },
  })
  res.status(201).json({ coupon: serializeCoupon(coupon) })
})

router.patch('/admin/coupons/:id', validate(couponSchema), async (req, res) => {
  const existing = await prisma.coupon.findUnique({ where: { id: req.params.id } })
  if (!existing) throw notFound('Coupon not found.')
  const coupon = await prisma.coupon.update({
    where: { id: existing.id },
    data: {
      ...couponData(req.body),
      products: {
        deleteMany: {},
        ...(req.body.appliesTo === 'SELECTED'
          ? { create: req.body.productIds.map((productId) => ({ productId })) }
          : {}),
      },
    },
    include: { products: { select: { productId: true } } },
  })
  res.json({ coupon: serializeCoupon(coupon) })
})

router.delete('/admin/coupons/:id', async (req, res) => {
  const existing = await prisma.coupon.findUnique({ where: { id: req.params.id } })
  if (!existing) throw notFound('Coupon not found.')
  await prisma.coupon.delete({ where: { id: existing.id } })
  res.json({ ok: true })
})

export default router
