import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound } from '../../lib/http-error.js'
import { requireAdmin } from '../../middleware/auth.js'
import { validate } from '../../middleware/validate.js'
import { sendMail } from '../../lib/mailer.js'
import { templates } from '../../lib/email-templates.js'
import { buildParcel, buyLabel, createShipmentWithRates, refreshRates } from '../../lib/easypost.js'
import { getSettings } from '../settings/settings.service.js'
import { ORDER_INCLUDE, serializeOrder } from './order.serializer.js'

const listQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  userId: z.string().trim().uuid().optional(),
  status: z.enum(['PENDING', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED']).optional(),
  paymentStatus: z.enum(['UNPAID', 'PAID', 'REFUNDED']).optional(),
  fulfillment: z.enum(['DELIVERY', 'PICKUP']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
})

const statusSchema = z.object({
  status: z.enum(['PENDING', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED']),
  notifyCustomer: z.boolean().default(true),
})

const paymentSchema = z.object({
  paymentStatus: z.enum(['UNPAID', 'PAID', 'REFUNDED']),
})

const labelSchema = z.object({
  rateId: z.string().trim().min(1).optional(),
})

const router = Router()

router.use(requireAdmin)

router.get('/', validate(listQuerySchema, 'query'), async (req, res) => {
  const { search, userId, status, paymentStatus, fulfillment, page, perPage } = req.validatedQuery

  const where = {
    ...(userId ? { userId } : {}),
    ...(status ? { status } : {}),
    ...(paymentStatus ? { paymentStatus } : {}),
    ...(fulfillment ? { fulfillment } : {}),
    ...(search
      ? {
          OR: [
            { orderNumber: { contains: search, mode: 'insensitive' } },
            { contactName: { contains: search, mode: 'insensitive' } },
            { contactEmail: { contains: search, mode: 'insensitive' } },
            { trackingCode: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}),
  }

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      include: ORDER_INCLUDE,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    prisma.order.count({ where }),
  ])

  res.json({
    orders: orders.map(serializeOrder),
    total,
    page,
    perPage,
    pages: Math.max(1, Math.ceil(total / perPage)),
  })
})

router.get('/stats', async (req, res) => {
  const since = new Date()
  since.setDate(since.getDate() - 30)

  const [statusGroups, paidAgg, monthAgg, customers, pendingUsers, lowStock, recent] =
    await Promise.all([
      prisma.order.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.order.aggregate({
        where: { paymentStatus: 'PAID' },
        _sum: { totalCents: true },
        _count: { _all: true },
      }),
      prisma.order.aggregate({
        where: { paymentStatus: 'PAID', createdAt: { gte: since } },
        _sum: { totalCents: true },
        _count: { _all: true },
      }),
      prisma.user.count({ where: { role: 'USER', deletedAt: null } }),
      prisma.user.count({ where: { status: 'PENDING', deletedAt: null } }),
      prisma.variant.count({ where: { stock: { lte: 5 }, isActive: true } }),
      prisma.order.findMany({
        include: ORDER_INCLUDE,
        orderBy: { createdAt: 'desc' },
        take: 6,
      }),
    ])

  const byStatus = statusGroups.reduce(
    (acc, row) => ({ ...acc, [row.status]: row._count._all }),
    {},
  )

  // Daily paid revenue for the last 30 days, zero-filled for the chart.
  const paidOrders = await prisma.order.findMany({
    where: { paymentStatus: 'PAID', createdAt: { gte: since } },
    select: { createdAt: true, totalCents: true },
  })

  const series = new Map()
  for (let i = 29; i >= 0; i -= 1) {
    const day = new Date()
    day.setDate(day.getDate() - i)
    series.set(day.toISOString().slice(0, 10), 0)
  }
  for (const order of paidOrders) {
    const key = order.createdAt.toISOString().slice(0, 10)
    if (series.has(key)) series.set(key, series.get(key) + order.totalCents)
  }

  res.json({
    stats: {
      revenueCents: paidAgg._sum.totalCents ?? 0,
      paidOrders: paidAgg._count._all,
      revenue30dCents: monthAgg._sum.totalCents ?? 0,
      orders30d: monthAgg._count._all,
      customers,
      pendingUsers,
      lowStock,
      byStatus,
      awaitingFulfilment: (byStatus.PENDING ?? 0) + (byStatus.PROCESSING ?? 0),
    },
    revenueSeries: [...series.entries()].map(([date, cents]) => ({ date, cents })),
    recentOrders: recent.map(serializeOrder),
  })
})

router.get('/:id', async (req, res) => {
  const order = await prisma.order.findUnique({
    where: { id: req.params.id },
    include: ORDER_INCLUDE,
  })
  if (!order) throw notFound('Order not found.')
  res.json({ order: serializeOrder(order) })
})

router.patch('/:id/status', validate(statusSchema), async (req, res) => {
  const { status, notifyCustomer } = req.body

  const existing = await prisma.order.findUnique({ where: { id: req.params.id } })
  if (!existing) throw notFound('Order not found.')

  const order = await prisma.order.update({
    where: { id: existing.id },
    data: {
      status,
      ...(status === 'SHIPPED' && !existing.shippedAt ? { shippedAt: new Date() } : {}),
      events: {
        create: {
          actorId: req.user.id,
          type: 'STATUS',
          message: `Status changed from ${existing.status.toLowerCase()} to ${status.toLowerCase()}.`,
        },
      },
    },
    include: ORDER_INCLUDE,
  })

  if (notifyCustomer) {
    const mail =
      status === 'SHIPPED' ? templates.orderShipped(order) : templates.orderStatusChanged(order)
    sendMail({ to: order.contactEmail, ...mail })
  }

  res.json({ order: serializeOrder(order) })
})

router.patch('/:id/payment', validate(paymentSchema), async (req, res) => {
  const { paymentStatus } = req.body

  const existing = await prisma.order.findUnique({ where: { id: req.params.id } })
  if (!existing) throw notFound('Order not found.')
  if (existing.paymentMethod === 'STRIPE') {
    throw badRequest('Stripe payments are managed automatically and cannot be changed manually.')
  }

  const order = await prisma.order.update({
    where: { id: existing.id },
    data: {
      paymentStatus,
      ...(paymentStatus === 'PAID' && !existing.paidAt ? { paidAt: new Date() } : {}),
      ...(paymentStatus === 'PAID' && existing.status === 'PENDING' ? { status: 'PROCESSING' } : {}),
      events: {
        create: {
          actorId: req.user.id,
          type: 'PAYMENT',
          message: `Payment marked as ${paymentStatus.toLowerCase()} by an administrator.`,
        },
      },
    },
    include: ORDER_INCLUDE,
  })

  res.json({ order: serializeOrder(order) })
})

/** Re-quotes a delivery order so an expired rate can be replaced. */
router.post('/:id/rates', async (req, res) => {
  const order = await prisma.order.findUnique({
    where: { id: req.params.id },
    include: { items: true },
  })
  if (!order) throw notFound('Order not found.')
  if (order.fulfillment !== 'DELIVERY') throw badRequest('Pickup orders do not need a label.')
  if (!order.addressLine1) throw badRequest('This order has no delivery address.')

  const settings = await getSettings()
  const parcel = buildParcel(order.items)

  const { shipmentId, rates } = await createShipmentWithRates({
    toAddress: {
      name: order.contactName,
      street1: order.addressLine1,
      street2: order.addressLine2 || undefined,
      city: order.city,
      state: order.state,
      zip: order.zip,
      country: order.country || 'US',
      phone: order.contactPhone,
      email: order.contactEmail,
    },
    fromAddress: settings.shipFrom,
    parcel,
  })

  await prisma.order.update({
    where: { id: order.id },
    data: { easypostShipmentId: shipmentId },
  })

  res.json({ shipmentId, rates })
})

router.post('/:id/label', validate(labelSchema), async (req, res) => {
  const order = await prisma.order.findUnique({ where: { id: req.params.id } })
  if (!order) throw notFound('Order not found.')
  if (order.labelUrl) throw badRequest('A label has already been purchased for this order.')
  if (order.fulfillment !== 'DELIVERY') throw badRequest('Pickup orders do not need a label.')
  if (!order.easypostShipmentId) {
    throw badRequest('This order has no shipment quote yet. Re-quote the rates first.')
  }

  const rateId = req.body.rateId || order.easypostRateId
  if (!rateId) throw badRequest('Choose a shipping rate before buying the label.')

  const label = await buyLabel({ shipmentId: order.easypostShipmentId, rateId })

  const updated = await prisma.order.update({
    where: { id: order.id },
    data: {
      labelUrl: label.labelUrl,
      trackingCode: label.trackingCode,
      trackingUrl: label.trackingUrl,
      carrier: label.carrier,
      service: label.service,
      easypostRateId: rateId,
      status: 'SHIPPED',
      shippedAt: new Date(),
      events: {
        create: {
          actorId: req.user.id,
          type: 'LABEL',
          message: `${label.carrier} ${label.service} label purchased${
            label.trackingCode ? ` (tracking ${label.trackingCode})` : ''
          }.`,
        },
      },
    },
    include: ORDER_INCLUDE,
  })

  sendMail({ to: updated.contactEmail, ...templates.orderShipped(updated) })

  res.json({ order: serializeOrder(updated) })
})

/** Refreshes stored rates without creating a new shipment. */
router.get('/:id/rates', async (req, res) => {
  const order = await prisma.order.findUnique({ where: { id: req.params.id } })
  if (!order) throw notFound('Order not found.')
  if (!order.easypostShipmentId) throw badRequest('This order has no shipment quote yet.')

  const result = await refreshRates(order.easypostShipmentId)
  res.json(result)
})

export default router
