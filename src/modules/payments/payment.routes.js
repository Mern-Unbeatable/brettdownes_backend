import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound } from '../../lib/http-error.js'
import { requireAuth } from '../../middleware/auth.js'
import { validate } from '../../middleware/validate.js'
import { rateLimit } from '../../middleware/rate-limit.js'
import { env } from '../../lib/env.js'
import { getStripe, sanitizeDescriptor } from '../../lib/stripe.js'
import { removePurchasedCartItems } from '../cart/cart.service.js'
import { ORDER_INCLUDE, serializeOrder } from '../orders/order.serializer.js'
import {
  applyPaidCheckoutSession,
  checkoutSessionIsPaid,
  markOrderPaid,
} from './payment.service.js'

const orderIdSchema = z.object({ orderId: z.string().min(1) })
const sessionSchema = z.object({
  orderId: z.string().min(1),
  sessionId: z.string().min(1),
})

const confirmThrottle = rateLimit({
  windowMs: 60_000,
  max: 20,
  message: 'Too many payment checks. Please wait a moment.',
})

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
    throw badRequest('This order is set to pay in person at pickup.')
  }
  if (order.status === 'CANCELLED') throw badRequest('This order was cancelled.')

  const { getSettings } = await import('../settings/settings.service.js')
  const settings = await getSettings()
  const stripe = getStripe()
  const descriptor = sanitizeDescriptor(settings.statementDescriptor)
  const clientUrl = env.clientUrl.replace(/\/$/, '')

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: order.contactEmail,
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
 * Auth is optional so Amazon Pay / wallet redirects still confirm if the
 * session cookie was dropped.
 */
router.post('/confirm-session', confirmThrottle, validate(sessionSchema), async (req, res) => {
  const order = await prisma.order.findUnique({
    where: { id: req.body.orderId },
    include: ORDER_INCLUDE,
  })
  if (!order) throw notFound('Order not found.')
  if (order.paymentStatus === 'PAID') {
    if (order.userId) {
      await removePurchasedCartItems(
        order.userId,
        order.items.map((item) => item.variantId),
      )
    }
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
    if (!sessionOrderId) {
      throw badRequest('This payment session does not match the order.')
    }
  }

  if (!checkoutSessionIsPaid(session)) {
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

  if (order.stripePaymentIntentId.startsWith('cs_')) {
    const session = await getStripe().checkout.sessions.retrieve(order.stripePaymentIntentId)
    if (checkoutSessionIsPaid(session)) {
      const paymentIntentId =
        typeof session.payment_intent === 'string'
          ? session.payment_intent
          : session.payment_intent?.id
      await markOrderPaid(order.id, { paymentIntentId })
      return res.json({ paid: true })
    }
    return res.json({ paid: false, status: session.status, paymentStatus: session.payment_status })
  }

  const intent = await getStripe().paymentIntents.retrieve(order.stripePaymentIntentId)
  if (intent.status !== 'succeeded') {
    return res.json({ paid: false, status: intent.status })
  }

  await markOrderPaid(order.id, { paymentIntentId: intent.id })
  res.json({ paid: true })
})

export async function handleStripeWebhook(req, res) {
  const stripe = getStripe()
  const signature = req.get('stripe-signature')
  const secret = env.stripe.webhookSecret
  if (!secret) {
    console.error('[stripe] STRIPE_WEBHOOK_SECRET is not set; ignoring webhook.')
    return res.status(503).json({ error: 'Webhook secret is not configured.' })
  }

  let event
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, secret)
  } catch (error) {
    console.error('[stripe] Webhook signature failed:', error.message)
    return res.status(400).json({ error: 'Invalid webhook signature.' })
  }

  try {
    if (
      event.type === 'checkout.session.completed' ||
      event.type === 'checkout.session.async_payment_succeeded'
    ) {
      const session = event.data.object
      if (checkoutSessionIsPaid(session) || event.type === 'checkout.session.async_payment_succeeded') {
        const full = await stripe.checkout.sessions.retrieve(session.id, {
          expand: ['payment_intent'],
        })
        await applyPaidCheckoutSession(full, {
          message: 'Payment confirmed by Stripe webhook.',
        })
      }
    }

    if (event.type === 'payment_intent.succeeded') {
      const intent = event.data.object
      const orderId = intent.metadata?.orderId
      if (orderId) {
        await markOrderPaid(orderId, {
          paymentIntentId: intent.id,
          message: 'Payment confirmed by Stripe webhook.',
        })
      }
    }
  } catch (error) {
    console.error('[stripe] Webhook handler failed:', error)
    return res.status(500).json({ error: 'Webhook processing failed.' })
  }

  res.json({ received: true })
}

export default router
