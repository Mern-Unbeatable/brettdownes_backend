import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound } from '../../lib/http-error.js'
import { requireAdmin } from '../../middleware/auth.js'
import { validate } from '../../middleware/validate.js'
import { sendMail } from '../../lib/mailer.js'
import { templates } from '../../lib/email-templates.js'
import { purchaseOrderLabel } from './label.service.js'
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

  // Delivery + Stripe: Processing/Shipped are driven by payment + EasyPost label.
  // Admin may only mark delivered / cancel / refund.
  if (existing.fulfillment === 'DELIVERY' && existing.paymentMethod === 'STRIPE') {
    const allowed = new Set(['DELIVERED', 'CANCELLED', 'REFUNDED'])
    if (!allowed.has(status)) {
      throw badRequest(
        'Delivery order status updates automatically (Processing after payment, Shipped when the label is bought). You can only mark Delivered, Cancelled, or Refunded here.',
      )
    }
  }

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

/** Retries the automatic label purchase using the customer's selected service. */
router.post('/:id/label/retry', async (req, res) => {
  const existing = await prisma.order.findUnique({
    where: { id: req.params.id },
    include: { items: true },
  })
  if (!existing) throw notFound('Order not found.')

  try {
    const order = await purchaseOrderLabel(existing, { actorId: req.user.id })
    res.json({ order: serializeOrder(order) })
  } catch (error) {
    await prisma.orderEvent.create({
      data: {
        orderId: existing.id,
        actorId: req.user.id,
        type: 'LABEL_FAILED',
        message: `Label retry failed: ${error.message || 'Unknown carrier error'}`,
      },
    })
    throw error
  }
})

/** Streams the purchased EasyPost label so admins can download it as a file. */
router.get('/:id/label/download', async (req, res) => {
  const order = await prisma.order.findUnique({ where: { id: req.params.id } })
  if (!order) throw notFound('Order not found.')
  if (!order.labelUrl) throw badRequest('This order does not have a shipping label yet.')

  const upstream = await fetch(order.labelUrl)
  if (!upstream.ok) {
    throw badRequest('Could not fetch the shipping label from the carrier.')
  }

  const contentType = upstream.headers.get('content-type') || 'application/pdf'
  const buffer = Buffer.from(await upstream.arrayBuffer())
  const filename = `shipping-label-${order.orderNumber}.pdf`

  res.setHeader('Content-Type', contentType)
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.setHeader('Content-Length', buffer.length)
  res.send(buffer)
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

export default router
