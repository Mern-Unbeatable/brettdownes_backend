import { prisma } from '../../lib/prisma.js'
import { sendMail } from '../../lib/mailer.js'
import { templates } from '../../lib/email-templates.js'
import { ORDER_INCLUDE } from './order.serializer.js'

const CLOSED = new Set(['DELIVERED', 'CANCELLED', 'REFUNDED'])

/** Maps EasyPost tracker status → our order status when an advance is needed. */
export function mapTrackerToOrderStatus(trackerStatus) {
  const status = String(trackerStatus || '')
    .trim()
    .toLowerCase()

  if (status === 'delivered') return 'DELIVERED'
  if (
    status === 'in_transit' ||
    status === 'out_for_delivery' ||
    status === 'available_for_pickup' ||
    status === 'pre_transit'
  ) {
    return 'SHIPPED'
  }
  return null
}

/**
 * Finds the order by tracking code and advances status from EasyPost tracker
 * updates (webhook or poll). Never downgrades delivered / cancelled / refunded.
 */
export async function applyTrackerUpdate({
  trackingCode,
  trackerStatus,
  trackingUrl = null,
  carrier = null,
}) {
  const code = String(trackingCode || '').trim()
  if (!code) return { updated: false, reason: 'missing-tracking-code' }

  const nextStatus = mapTrackerToOrderStatus(trackerStatus)
  if (!nextStatus) return { updated: false, reason: 'ignored-status', trackerStatus }

  const order = await prisma.order.findFirst({
    where: {
      trackingCode: { equals: code, mode: 'insensitive' },
      fulfillment: 'DELIVERY',
    },
    include: ORDER_INCLUDE,
  })
  if (!order) return { updated: false, reason: 'order-not-found', trackingCode: code }
  if (CLOSED.has(order.status)) {
    return { updated: false, reason: 'order-closed', orderId: order.id, status: order.status }
  }

  // Only move forward: PROCESSING → SHIPPED → DELIVERED
  const rank = { PENDING: 0, PROCESSING: 1, SHIPPED: 2, DELIVERED: 3 }
  if ((rank[nextStatus] || 0) <= (rank[order.status] || 0)) {
    // Still refresh tracking URL if EasyPost sent a newer public link.
    if (trackingUrl && trackingUrl !== order.trackingUrl) {
      await prisma.order.update({
        where: { id: order.id },
        data: { trackingUrl },
      })
    }
    return { updated: false, reason: 'already-current', orderId: order.id, status: order.status }
  }

  const updated = await prisma.order.update({
    where: { id: order.id },
    data: {
      status: nextStatus,
      ...(trackingUrl ? { trackingUrl } : {}),
      ...(carrier && !order.carrier ? { carrier } : {}),
      ...(nextStatus === 'SHIPPED' && !order.shippedAt ? { shippedAt: new Date() } : {}),
      events: {
        create: {
          type: 'TRACKING',
          message:
            nextStatus === 'DELIVERED'
              ? `Carrier marked package delivered (EasyPost: ${trackerStatus}).`
              : `Tracking update: ${trackerStatus} → order marked ${nextStatus.toLowerCase()}.`,
        },
      },
    },
    include: ORDER_INCLUDE,
  })

  if (nextStatus === 'DELIVERED') {
    sendMail({ to: updated.contactEmail, ...templates.orderStatusChanged(updated) })
  } else if (nextStatus === 'SHIPPED' && order.status !== 'SHIPPED') {
    sendMail({ to: updated.contactEmail, ...templates.orderShipped(updated) })
  }

  return {
    updated: true,
    orderId: updated.id,
    orderNumber: updated.orderNumber,
    from: order.status,
    to: nextStatus,
  }
}
