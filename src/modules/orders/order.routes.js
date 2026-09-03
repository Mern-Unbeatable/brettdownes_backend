import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound } from '../../lib/http-error.js'
import { requireAuth, invalidateUserCache } from '../../middleware/auth.js'
import { validate } from '../../middleware/validate.js'
import { sendMail } from '../../lib/mailer.js'
import { templates } from '../../lib/email-templates.js'
import { refreshRates } from '../../lib/easypost.js'
import { getAdminRecipients, getSettings } from '../settings/settings.service.js'
import { removePurchasedCartItems } from '../cart/cart.service.js'
import { nextOrderNumber, resolveCart } from './cart.service.js'
import {
  calculateBulkDiscount,
  calculateCouponDiscount,
  getActiveDiscountTiers,
} from './discount.service.js'
import { deductOrderStock, restoreOrderStock } from './inventory.service.js'
import { purchaseOrderLabel } from './label.service.js'
import { ORDER_INCLUDE, ORDER_LIST_INCLUDE, serializeOrder } from './order.serializer.js'

const createOrderSchema = z
  .object({
    items: z
      .array(
        z.object({
          variantId: z.string().min(1),
          qty: z.coerce.number().int().min(1).max(999),
        }),
      )
      .min(1, 'Your cart is empty.'),
    fulfillment: z.enum(['DELIVERY', 'PICKUP']),
    contact: z.object({
      name: z.string().trim().min(1, 'Full name is required.').max(120),
      email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
      phone: z.string().trim().min(1, 'Phone number is required.').max(40),
    }),
    address: z
      .object({
        line1: z.string().trim().min(1).max(200),
        line2: z.string().trim().max(200).optional().or(z.literal('')),
        city: z.string().trim().min(1).max(120),
        state: z.string().trim().min(1).max(60),
        zip: z.string().trim().min(2).max(20),
        country: z.string().trim().length(2).default('US'),
      })
      .optional(),
    shipmentId: z.string().trim().max(120).optional(),
    rateId: z.string().trim().max(120).optional(),
    pickupLocationId: z.string().trim().min(1).max(80).optional(),
    notes: z.string().trim().max(2000).optional().or(z.literal('')),
    couponCode: z.string().trim().max(40).optional().or(z.literal('')),
    /** When true, apply available account credit to merchandise only (not shipping). */
    applyCredit: z.boolean().default(false),
    saveAddress: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if (value.fulfillment === 'PICKUP') {
      if (!value.pickupLocationId) {
        ctx.addIssue({
          code: 'custom',
          path: ['pickupLocationId'],
          message: 'Choose a pickup location.',
        })
      }
      return
    }
    if (!value.address) {
      ctx.addIssue({ code: 'custom', path: ['address'], message: 'A delivery address is required.' })
    }
    if (!value.shipmentId || !value.rateId) {
      ctx.addIssue({
        code: 'custom',
        path: ['rateId'],
        message: 'Select a shipping rate before placing the order.',
      })
    }
  })

const router = Router()

router.use(requireAuth)

router.post('/', validate(createOrderSchema), async (req, res) => {
  const body = req.body
  const { items, subtotalCents } = await resolveCart(body.items)
  const settings = await getSettings()

  let shippingCents = 0
  let carrier = null
  let service = null
  let pickupLocation = null

  if (body.fulfillment === 'PICKUP') {
    pickupLocation =
      settings.pickupLocations.find((entry) => entry.id === body.pickupLocationId) || null
    if (!pickupLocation) {
      throw badRequest('That pickup location is no longer available. Choose another location.')
    }
  } else if (body.fulfillment === 'DELIVERY') {
    const qualifiesFree =
      settings.freeShippingThresholdCents > 0 &&
      subtotalCents >= settings.freeShippingThresholdCents

    // Re-read the rate from EasyPost so the client cannot dictate the shipping cost.
    const shipCountry = String(body.address?.country || 'US').trim().toUpperCase()
    const { rates } = await refreshRates(body.shipmentId, {
      international: shipCountry !== 'US',
    })
    const rate = rates.find((entry) => entry.id === body.rateId)
    if (!rate) {
      throw badRequest('That shipping rate has expired. Please recalculate shipping and try again.')
    }

    shippingCents = qualifiesFree ? 0 : rate.amountCents + settings.handlingFeeCents
    carrier = rate.carrier
    service = rate.service
  }

  const tiers = await getActiveDiscountTiers()
  const bulkDiscount = calculateBulkDiscount(items, tiers.map((tier) => ({
    ...tier,
    detail: tier.name,
  })))
  const couponDiscount = body.couponCode
    ? await calculateCouponDiscount(items, body.couponCode)
    : null
  const discountCents = Math.min(
    subtotalCents,
    bulkDiscount.discountCents + (couponDiscount?.discountCents || 0),
  )
  const discountLabel = [bulkDiscount.discountLabel, couponDiscount?.discountLabel]
    .filter(Boolean)
    .join(' + ') || null

  const dueMerchandiseCents = Math.max(0, subtotalCents - discountCents)
  const orderTotalBeforeCredit = dueMerchandiseCents + shippingCents

  // Atomically reserve account credit so concurrent checkouts cannot overspend it.
  // Credit reduces merchandise only — shipping / pickup fees stay payable.
  const order = await prisma.$transaction(async (tx) => {
    const account = await tx.user.findUnique({
      where: { id: req.user.id },
      select: { creditCents: true },
    })
    const available = Math.max(0, account?.creditCents || 0)
    const creditCents = body.applyCredit
      ? Math.min(available, dueMerchandiseCents)
      : 0
    const totalCents = Math.max(0, orderTotalBeforeCredit - creditCents)
    const paymentMethod = body.fulfillment === 'PICKUP' ? 'PICKUP' : 'STRIPE'
    const coveredByCredit = totalCents === 0 && creditCents > 0

    if (creditCents > 0) {
      const reserved = await tx.user.updateMany({
        where: { id: req.user.id, creditCents: { gte: creditCents } },
        data: { creditCents: { decrement: creditCents } },
      })
      if (reserved.count !== 1) {
        throw badRequest('Your account credit changed. Refresh and try again.')
      }
    }

    return tx.order.create({
      data: {
        orderNumber: await nextOrderNumber(),
        userId: req.user.id,
        status: coveredByCredit ? 'PROCESSING' : 'PENDING',
        paymentStatus: coveredByCredit ? 'PAID' : 'UNPAID',
        paymentMethod,
        fulfillment: body.fulfillment,

        subtotalCents,
        discountCents,
        discountLabel,
        couponCode: couponDiscount?.code || null,
        creditCents,
        shippingCents,
        totalCents,
        ...(coveredByCredit ? { paidAt: new Date() } : {}),

        contactName: body.contact.name,
        contactEmail: body.contact.email,
        contactPhone: body.contact.phone,

        // Delivery address, or pickup location snapshot for warehouse orders.
        addressLine1:
          body.fulfillment === 'PICKUP' ? pickupLocation.name : body.address?.line1 || null,
        addressLine2:
          body.fulfillment === 'PICKUP'
            ? (pickupLocation.lines || []).join('\n') || null
            : body.address?.line2 || null,
        city: body.fulfillment === 'PICKUP' ? null : body.address?.city || null,
        state: body.fulfillment === 'PICKUP' ? null : body.address?.state || null,
        zip: body.fulfillment === 'PICKUP' ? null : body.address?.zip || null,
        country: body.fulfillment === 'PICKUP' ? 'US' : body.address?.country || 'US',
        notes: body.notes || null,

        easypostShipmentId: body.shipmentId || null,
        easypostRateId: body.rateId || null,
        carrier,
        service,

        items: {
          create: items.map((item) => ({
            variantId: item.variantId,
            productName: item.productName,
            dose: item.dose,
            barcode: item.barcode,
            image: item.image,
            unitPriceCents: item.unitPriceCents,
            qty: item.qty,
            weightOz: item.weightOz,
          })),
        },
        events: {
          create: {
            actorId: req.user.id,
            type: 'CREATED',
            message: coveredByCredit
              ? `Order placed and paid in full with $${(creditCents / 100).toFixed(2)} account credit.`
              : paymentMethod === 'PICKUP'
                ? `Order placed for pickup at ${pickupLocation.name}, payment due on collection.`
                : creditCents > 0
                  ? `Order placed with $${(creditCents / 100).toFixed(2)} account credit on merchandise, awaiting card payment.`
                  : 'Order placed, awaiting card payment.',
          },
        },
      },
      include: ORDER_INCLUDE,
    })
  })

  if (order.creditCents > 0) {
    invalidateUserCache(req.user.id)
  }

  const paymentMethod = order.paymentMethod
  const coveredByCredit = order.paymentStatus === 'PAID' && order.creditCents > 0 && order.totalCents === 0

  if (body.saveAddress && body.address) {
    await prisma.address.create({
      data: {
        userId: req.user.id,
        line1: body.address.line1,
        line2: body.address.line2 || null,
        city: body.address.city,
        state: body.address.state,
        zip: body.address.zip,
        country: body.address.country,
        isDefault: (await prisma.address.count({ where: { userId: req.user.id } })) === 0,
      },
    })
  }

  // Pickup orders and fully credit-covered orders are confirmed immediately.
  if (paymentMethod === 'PICKUP' || coveredByCredit) {
    let finalized = order
    if (coveredByCredit && order.fulfillment === 'DELIVERY' && !order.labelUrl) {
      try {
        finalized = await purchaseOrderLabel(order)
      } catch (error) {
        console.error(
          `[shipping] Automatic label purchase failed for credit-paid order ${order.orderNumber}:`,
          error,
        )
        await prisma.orderEvent.create({
          data: {
            orderId: order.id,
            type: 'LABEL_FAILED',
            message: `Automatic label purchase failed: ${error.message || 'Unknown carrier error'}`,
          },
        })
      }
    }

    await deductOrderStock(finalized, { actorId: req.user.id })
    if (couponDiscount?.couponId) {
      await prisma.coupon.update({
        where: { id: couponDiscount.couponId },
        data: { usageCount: { increment: 1 } },
      })
    }
    await removePurchasedCartItems(
      req.user.id,
      finalized.items.map((item) => item.variantId),
    )
    sendMail({ to: finalized.contactEmail, ...templates.orderConfirmation(finalized) })
    if (settings.notifyNewOrder) {
      sendMail({ to: await getAdminRecipients(settings), ...templates.adminNewOrder(finalized) })
    }
    return res.status(201).json({ order: serializeOrder(finalized) })
  }

  res.status(201).json({ order: serializeOrder(order) })
})

router.get('/mine', async (req, res) => {
  const orders = await prisma.order.findMany({
    where: { userId: req.user.id },
    include: ORDER_LIST_INCLUDE,
    orderBy: { createdAt: 'desc' },
  })

  const paid = orders.filter((order) => order.paymentStatus === 'PAID')

  res.json({
    orders: orders.map(serializeOrder),
    stats: {
      total: orders.length,
      inTransit: orders.filter((order) => order.status === 'SHIPPED').length,
      delivered: orders.filter((order) => order.status === 'DELIVERED').length,
      spentCents: paid.reduce((sum, order) => sum + order.totalCents, 0),
    },
  })
})

router.get('/mine/:id', async (req, res) => {
  const order = await prisma.order.findFirst({
    where: { id: req.params.id, userId: req.user.id },
    include: ORDER_INCLUDE,
  })
  if (!order) throw notFound('Order not found.')
  res.json({ order: serializeOrder(order) })
})

router.post('/mine/:id/cancel', async (req, res) => {
  const order = await prisma.order.findFirst({
    where: { id: req.params.id, userId: req.user.id },
    include: ORDER_INCLUDE,
  })
  if (!order) throw notFound('Order not found.')
  if (order.paymentStatus === 'PAID' || order.status !== 'PENDING') {
    throw badRequest('This order can no longer be cancelled. Contact support for help.')
  }

  const updated = await prisma.$transaction(async (tx) => {
    const cancelled = await tx.order.update({
      where: { id: order.id },
      data: {
        status: 'CANCELLED',
        events: {
          create: { actorId: req.user.id, type: 'CANCELLED', message: 'Cancelled by the customer.' },
        },
      },
      include: ORDER_INCLUDE,
    })

    if (order.creditCents > 0 && order.userId) {
      await tx.user.update({
        where: { id: order.userId },
        data: { creditCents: { increment: order.creditCents } },
      })
    }

    return cancelled
  })

  if (order.creditCents > 0 && order.userId) {
    invalidateUserCache(order.userId)
  }

  await restoreOrderStock(updated, { actorId: req.user.id })

  res.json({ order: serializeOrder(updated) })
})

export default router
