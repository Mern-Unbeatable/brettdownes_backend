import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth } from '../../middleware/auth.js'
import { validate } from '../../middleware/validate.js'
import { resolveCart } from '../orders/cart.service.js'
import { getUserCart } from './cart.service.js'

const cartSchema = z.object({
  items: z
    .array(
      z.object({
        variantId: z.string().uuid(),
        qty: z.coerce.number().int().min(1).max(999),
      }),
    )
    .max(200),
})

const router = Router()
router.use(requireAuth)

router.get('/', async (req, res) => {
  res.json({ items: await getUserCart(req.user.id) })
})

/**
 * Replaces the authenticated user's cart. The frontend saves optimistically
 * and sends the complete cart after each change, keeping devices in sync.
 */
router.put('/', validate(cartSchema), async (req, res) => {
  const combined = new Map()
  for (const item of req.body.items) {
    combined.set(item.variantId, (combined.get(item.variantId) || 0) + item.qty)
  }

  const lines = [...combined].map(([variantId, qty]) => ({
    variantId,
    qty: Math.min(qty, 999),
  }))

  if (lines.length) {
    // Validates availability and prevents arbitrary variant ids entering carts.
    await resolveCart(lines)
  }

  await prisma.$transaction([
    prisma.cartItem.deleteMany({ where: { userId: req.user.id } }),
    ...(lines.length
      ? [
          prisma.cartItem.createMany({
            data: lines.map((item) => ({ userId: req.user.id, ...item })),
          }),
        ]
      : []),
  ])

  res.json({ items: await getUserCart(req.user.id) })
})

router.delete('/', async (req, res) => {
  await prisma.cartItem.deleteMany({ where: { userId: req.user.id } })
  res.status(204).end()
})

export default router
