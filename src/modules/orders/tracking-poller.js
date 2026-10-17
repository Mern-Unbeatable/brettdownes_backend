import { prisma } from '../../lib/prisma.js'
import { env } from '../../lib/env.js'
import { fetchCarrierTracking } from '../../lib/easypost.js'
import { applyCarrierScans, applyWholesaleCarrierScans } from './tracking.service.js'

const INTERVAL_MS = 60_000
let running = false

async function checkOpenShipments() {
  if (running) return
  if (!env.easypost.trackingApiKey) return
  running = true

  try {
    const orders = await prisma.order.findMany({
      where: {
        fulfillment: 'DELIVERY',
        trackingCode: { not: null },
        status: { in: ['PROCESSING', 'SHIPPED'] },
      },
      select: {
        id: true,
        orderNumber: true,
        trackingCode: true,
        carrier: true,
        service: true,
        status: true,
      },
    })

    for (const order of orders) {
      try {
        const snapshot = await fetchCarrierTracking({
          trackingCode: order.trackingCode,
          carrier: `${order.carrier || ''} ${order.service || ''}`,
        })
        const result = await applyCarrierScans(order, snapshot)
        if (result.added > 0 || result.status !== order.status) {
          console.log(
            `[tracking] ${order.orderNumber} +${result.added} scans → ${result.status}`,
          )
        }
      } catch (error) {
        console.error(`[tracking] ${order.orderNumber}: ${error.message}`)
      }
    }

    const storeOrders = await prisma.wholesaleOrder.findMany({
      where: {
        trackingCode: { not: null },
        status: { in: ['PROCESSING', 'SHIPPED'] },
      },
      select: {
        id: true,
        orderNumber: true,
        trackingCode: true,
        carrier: true,
        shippingLabel: true,
        status: true,
        contactEmail: true,
      },
    })

    for (const order of storeOrders) {
      try {
        const snapshot = await fetchCarrierTracking({
          trackingCode: order.trackingCode,
          carrier: `${order.carrier || ''} ${order.shippingLabel || ''}`,
        })
        const result = await applyWholesaleCarrierScans(order, snapshot)
        if (result.added > 0 || result.status !== order.status) {
          console.log(
            `[tracking] ${order.orderNumber} (store) +${result.added} scans → ${result.status}`,
          )
        }
      } catch (error) {
        console.error(`[tracking] ${order.orderNumber} (store): ${error.message}`)
      }
    }
  } catch (error) {
    console.error('[tracking]', error.message)
  } finally {
    running = false
  }
}

/** Checks open delivery tracking every minute and writes new scans to the timeline. */
export function startTrackingPoller() {
  const boot = setTimeout(checkOpenShipments, 8000)
  const timer = setInterval(checkOpenShipments, INTERVAL_MS)
  return () => {
    clearTimeout(boot)
    clearInterval(timer)
  }
}
