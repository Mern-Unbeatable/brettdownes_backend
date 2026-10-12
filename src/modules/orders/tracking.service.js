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

function scanStamp(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toISOString().slice(0, 19)
}

function scanMessage(scan) {
  const place = [scan.city, scan.state].filter(Boolean).join(', ')
  const text = scan.message || scan.status || ''
  return [text, place].filter(Boolean).join(' — ')
}

/**
 * Writes new carrier scans onto the order timeline and marks the order
 * delivered when USPS, UPS, or FedEx says the package was delivered.
 */
export async function applyCarrierScans(order, snapshot) {
  const existing = await prisma.orderEvent.findMany({
    where: { orderId: order.id, type: 'TRACKING' },
    select: { message: true, createdAt: true },
  })
  const seen = new Set(existing.map((event) => `${event.message}|${scanStamp(event.createdAt)}`))
  const fresh = []

  for (const scan of snapshot.events || []) {
    const message = scanMessage(scan)
    if (!message) continue
    const createdAt = scan.datetime ? new Date(scan.datetime) : new Date()
    const when = Number.isNaN(createdAt.getTime()) ? new Date() : createdAt
    const key = `${message}|${scanStamp(when)}`
    if (seen.has(key)) continue
    seen.add(key)
    fresh.push({ message, createdAt: when })
  }

  const nextStatus = mapTrackerToOrderStatus(snapshot.status)
  const rank = { PENDING: 0, PROCESSING: 1, SHIPPED: 2, DELIVERED: 3 }
  const advance =
    nextStatus &&
    !CLOSED.has(order.status) &&
    (rank[nextStatus] || 0) > (rank[order.status] || 0)

  if (!fresh.length && !advance) {
    return { added: 0, status: order.status }
  }

  const updated = await prisma.order.update({
    where: { id: order.id },
    data: {
      ...(advance ? { status: nextStatus } : {}),
      ...(snapshot.carrier && !order.carrier ? { carrier: snapshot.carrier } : {}),
      ...(fresh.length
        ? {
            events: {
              create: fresh.map((event) => ({
                type: 'TRACKING',
                message: event.message,
                createdAt: event.createdAt,
              })),
            },
          }
        : {}),
    },
    include: ORDER_INCLUDE,
  })

  if (advance && nextStatus === 'DELIVERED') {
    sendMail({ to: updated.contactEmail, ...templates.orderStatusChanged(updated) })
  }

  return {
    added: fresh.length,
    status: updated.status,
    from: order.status,
  }
}
