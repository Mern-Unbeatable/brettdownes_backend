import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound } from '../../lib/http-error.js'
import { requireAuth } from '../../middleware/auth.js'
import { validate } from '../../middleware/validate.js'
import { env } from '../../lib/env.js'
import { getStripe, sanitizeDescriptor } from '../../lib/stripe.js'
import { sendMail } from '../../lib/mailer.js'
import { templates } from '../../lib/email-templates.js'
import { getAdminRecipients, getSettings } from '../settings/settings.service.js'
import { ORDER_INCLUDE, serializeOrder } from '../orders/order.serializer.js'

const orderIdSchema = z.object({ orderId: z.string().min(1) })
const sessionSchema = z.object({
  orderId: z.string().min(1),
  sessionId: z.string().min(1),
})

/** Marks an order paid exactly once and fires the confirmation emails. */
async function markOrderPaid(orderId, { paymentIntentId } = {}) {
  const existing = await prisma.order.findUnique({ where: { id: orderId } })
  if (!existing || existing.paymentStatus === 'PAID') return null

  const order = await prisma.order.update({
    where: { id: orderId },
    data: {
      paymentStatus: 'PAID',
      status: existing.status === 'PENDING' ? 'PROCESSING' : existing.status,
      paidAt: new Date(),
      ...(paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}),
      events: {
        create: { type: 'PAYMENT', message: 'Card payment confirmed by Stripe.' },
      },
    },
    include: ORDER_INCLUDE,
  })

  const settings = await getSettings()
  sendMail({ to: order.contactEmail, ...templates.orderConfirmation(order) })
  if (settings.notifyNewOrder) {
    sendMail({ to: await getAdminRecipients(settings), ...templates.adminNewOrder(order) })
  }

  return order
}

const router = Router()

/**
 * Creates a Stripe Checkout Session with amount only — no product catalog,
 * no line-item descriptions of peptides. The hosted page shows the total.
 */
router.post('/checkout-session', requireAuth, validate(orderIdSchema), async (req, res) => {
  const order = await prisma.order.findFirst({
    where: { id: req.body.orderId, userId: req.user.id },
  })
  if (!order) throw notFound('Order not found.')
  if (order.paymentStatus === 'PAID') throw badRequest('This order has already been paid.')
  if (order.paymentMethod !== 'STRIPE') {
    throw badRequest('This order is set to warehouse pickup and is paid on collection.')
  }
  if (order.status === 'CANCELLED') throw badRequest('This order was cancelled.')

  const settings = await getSettings()
  const stripe = getStripe()
  const descriptor = sanitizeDescriptor(settings.statementDescriptor)
  const clientUrl = env.clientUrl.replace(/\/$/, '')

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: order.contactEmail,
    // Amount only — Stripe Checkout still needs a generic product label.
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: order.currency || 'usd',
          unit_amount: order.totalCents,
          product_data: {
            name: 'Payment',
          },
        },
      },
    ],
    metadata: {
      orderId: order.id,
      orderNumber: order.orderNumber,
    },
    payment_intent_data: {
      statement_descriptor_suffix: descriptor || undefined,
      metadata: {
        orderId: order.id,
        orderNumber: order.orderNumber,
      },
    },
    success_url: `${clientUrl}/checkout/success?orderId=${encodeURIComponent(order.id)}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${clientUrl}/checkout/cancel?orderId=${encodeURIComponent(order.id)}`,
  })

  // Reuse the Stripe id column to remember the Checkout Session until paid.
  await prisma.order.update({
    where: { id: order.id },
    data: { stripePaymentIntentId: session.id },
  })

  res.json({
    url: session.url,
    sessionId: session.id,
    descriptor,
  })
})

/**
 * Verifies a completed Checkout Session and marks the order paid.
 * Called from the success page — we only trust Stripe's session status.
 */
router.post('/confirm-session', requireAuth, validate(sessionSchema), async (req, res) => {
  const order = await prisma.order.findFirst({
    where: { id: req.body.orderId, userId: req.user.id },
    include: ORDER_INCLUDE,
  })
  if (!order) throw notFound('Order not found.')
  if (order.paymentStatus === 'PAID') {
    return res.json({ paid: true, order: serializeOrder(order) })
  }

  const session = await getStripe().checkout.sessions.retrieve(req.body.sessionId, {
    expand: ['payment_intent'],
  })

  const sessionOrderId =
    session.metadata?.orderId ||
    (typeof session.payment_intent === 'object' ? session.payment_intent?.metadata?.orderId : null)

  if (sessionOrderId && sessionOrderId !== order.id) {
    throw badRequest('This payment session does not match the order.')
  }

  if (
    order.stripePaymentIntentId &&
    order.stripePaymentIntentId !== session.id &&
    order.stripePaymentIntentId !==
      (typeof session.payment_intent === 'string'
        ? session.payment_intent
        : session.payment_intent?.id)
  ) {
    // Allow confirm when the stored id is an older session for the same order,
    // as long as Stripe metadata ties this session to the order.
    if (!sessionOrderId) {
      throw badRequest('This payment session does not match the order.')
    }
  }

  if (session.payment_status !== 'paid' && session.status !== 'complete') {
    return res.json({ paid: false, status: session.status, paymentStatus: session.payment_status })
  }

  const paymentIntentId =
    typeof session.payment_intent === 'string'
      ? session.payment_intent
      : session.payment_intent?.id

  const paid = await markOrderPaid(order.id, { paymentIntentId })
  const fresh = paid
    ? paid
    : await prisma.order.findUnique({ where: { id: order.id }, include: ORDER_INCLUDE })

  res.json({ paid: true, order: serializeOrder(fresh) })
})

/** Legacy Elements confirm — kept for any in-flight clients. */
router.post('/confirm', requireAuth, validate(orderIdSchema), async (req, res) => {
  const order = await prisma.order.findFirst({
    where: { id: req.body.orderId, userId: req.user.id },
  })
  if (!order) throw notFound('Order not found.')
  if (order.paymentStatus === 'PAID') return res.json({ paid: true })
  if (!order.stripePaymentIntentId) throw badRequest('No payment has been started for this order.')

  // Checkout Session ids start with cs_ — confirm via session retrieve.
  if (order.stripePaymentIntentId.startsWith('cs_')) {
    const session = await getStripe().checkout.sessions.retrieve(order.stripePaymentIntentId)
    if (session.payment_status === 'paid' || session.status === 'complete') {
      const paymentIntentId =
        typeof session.payment_intent === 'string'
          ? session.payment_intent
          : session.payment_intent?.id
      await markOrderPaid(order.id, { paymentIntentId })
      return res.json({ paid: true })
    }
    return res.json({ paid: false, status: session.status })
  }

  const intent = await getStripe().paymentIntents.retrieve(order.stripePaymentIntentId)
  if (intent.status !== 'succeeded') {
    return res.json({ paid: false, status: intent.status })
  }

  await markOrderPaid(order.id, { paymentIntentId: intent.id })
  res.json({ paid: true })
})

export default router
