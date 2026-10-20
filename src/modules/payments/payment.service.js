import { prisma } from '../../lib/prisma.js'
import { getStripe } from '../../lib/stripe.js'
import { sendMail } from '../../lib/mailer.js'
import { templates } from '../../lib/email-templates.js'
import { getAdminRecipients, getSettings } from '../settings/settings.service.js'
import { removePurchasedCartItems } from '../cart/cart.service.js'
import { deductOrderStock } from '../orders/inventory.service.js'
import { ORDER_INCLUDE } from '../orders/order.serializer.js'

export function checkoutSessionIsPaid(session) {
  return String(session?.payment_status || '') === 'paid'
}

function paymentIntentIdFromSession(session) {
  if (!session?.payment_intent) return null
  return typeof session.payment_intent === 'string'
    ? session.payment_intent
    : session.payment_intent.id
}

function orderIdFromSession(session) {
  const fromMeta = session?.metadata?.orderId
  if (fromMeta) return fromMeta
  const intent = session?.payment_intent
  if (intent && typeof intent === 'object') return intent.metadata?.orderId || null
  return null
}

/** Marks an order paid exactly once and fires confirmation emails. */
export async function markOrderPaid(orderId, { paymentIntentId, message } = {}) {
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
        create: {
          type: 'PAYMENT',
          message: message || 'Payment confirmed by Stripe.',
        },
      },
    },
    include: ORDER_INCLUDE,
  })

  await deductOrderStock(order)

  if (order.couponCode) {
    await prisma.coupon.updateMany({
      where: { code: order.couponCode },
      data: { usageCount: { increment: 1 } },
    })
  }

  if (order.userId) {
    await removePurchasedCartItems(
      order.userId,
      order.items.map((item) => item.variantId),
    )
  }

  const settings = await getSettings()
  sendMail({ to: order.contactEmail, ...templates.orderConfirmation(order) })
  if (settings.notifyNewOrder) {
    sendMail({ to: await getAdminRecipients(settings), ...templates.adminNewOrder(order) })
  }

  return order
}

export async function applyPaidCheckoutSession(session, { message } = {}) {
  if (!checkoutSessionIsPaid(session)) {
    return { paid: false, status: session.status, paymentStatus: session.payment_status }
  }

  const orderId = orderIdFromSession(session)
  if (!orderId) return { paid: false, reason: 'no-order-id' }

  const order = await markOrderPaid(orderId, {
    paymentIntentId: paymentIntentIdFromSession(session),
    message,
  })
  return { paid: true, order: order || true, orderId }
}

/**
 * Re-reads the stored Stripe Checkout Session (or payment intent) and marks
 * the order paid when Stripe says the charge succeeded. Amazon Pay often
 * never returns to the success page, so this is the admin / webhook backup.
 */
export async function syncOrderPaymentFromStripe(order) {
  if (!order) return { paid: false, reason: 'missing-order' }
  if (order.paymentStatus === 'PAID') return { paid: true, already: true }

  const stripe = getStripe()
  const stored = String(order.stripePaymentIntentId || '')

  if (stored.startsWith('cs_')) {
    const session = await stripe.checkout.sessions.retrieve(stored, {
      expand: ['payment_intent'],
    })
    if (!checkoutSessionIsPaid(session)) {
      return {
        paid: false,
        status: session.status,
        paymentStatus: session.payment_status,
      }
    }
    const paid = await markOrderPaid(order.id, {
      paymentIntentId: paymentIntentIdFromSession(session),
      message: 'Payment confirmed by Stripe.',
    })
    return { paid: true, order: paid }
  }

  if (stored.startsWith('pi_')) {
    const intent = await stripe.paymentIntents.retrieve(stored)
    if (intent.status !== 'succeeded') {
      return { paid: false, status: intent.status }
    }
    const paid = await markOrderPaid(order.id, {
      paymentIntentId: intent.id,
      message: 'Payment confirmed by Stripe.',
    })
    return { paid: true, order: paid }
  }

  return { paid: false, reason: 'no-stripe-id' }
}
