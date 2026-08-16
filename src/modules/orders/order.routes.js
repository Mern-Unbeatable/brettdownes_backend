import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound } from '../../lib/http-error.js'
import { requireAuth } from '../../middleware/auth.js'
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
        zip: z.string().trim().min(3).max(20),
        country: z.string().trim().length(2).default('US'),
      })
      .optional(),
    shipmentId: z.string().trim().max(120).optional(),
    rateId: z.string().trim().max(120).optional(),
    pickupLocationId: z.string().trim().min(1).max(80).optional(),
    notes: z.string().trim().max(2000).optional().or(z.literal('')),
    couponCode: z.string().trim().max(40).optional().or(z.literal('')),
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
    const { rates } = await refreshRates(body.shipmentId)
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
  const totalCents = Math.max(0, subtotalCents - discountCents + shippingCents)
  const paymentMethod = body.fulfillment === 'PICKUP' ? 'PICKUP' : 'STRIPE'

  const order = await prisma.order.create({
    data: {
      orderNumber: await nextOrderNumber(),
      userId: req.user.id,
      status: 'PENDING',
      paymentStatus: 'UNPAID',
      paymentMethod,
      fulfillment: body.fulfillment,

      subtotalCents,
      discountCents,
      discountLabel,
      couponCode: couponDiscount?.code || null,
      shippingCents,
      totalCents,

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
          sku: item.sku,
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
          message:
            paymentMethod === 'PICKUP'
              ? `Order placed for pickup at ${pickupLocation.name}, payment due on collection.`
              : 'Order placed, awaiting card payment.',
        },
      },
    },
    include: ORDER_INCLUDE,
  })

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

  // Pickup orders are confirmed immediately; card orders wait for /payments/confirm.
  if (paymentMethod === 'PICKUP') {
    if (couponDiscount?.couponId) {
      await prisma.coupon.update({
        where: { id: couponDiscount.couponId },
        data: { usageCount: { increment: 1 } },
      })
    }
    await removePurchasedCartItems(
      req.user.id,
      order.items.map((item) => item.variantId),
    )
    sendMail({ to: order.contactEmail, ...templates.orderConfirmation(order) })
    if (settings.notifyNewOrder) {
      sendMail({ to: await getAdminRecipients(settings), ...templates.adminNewOrder(order) })
    }
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

  const updated = await prisma.order.update({
    where: { id: order.id },
    data: {
      status: 'CANCELLED',
      events: {
        create: { actorId: req.user.id, type: 'CANCELLED', message: 'Cancelled by the customer.' },
      },
    },
    include: ORDER_INCLUDE,
  })

  res.json({ order: serializeOrder(updated) })
})

export default router
