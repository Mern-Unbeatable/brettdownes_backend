import { prisma } from '../../lib/prisma.js'

const DEDUCT_EVENT = 'INVENTORY_DEDUCT'
const RESTORE_EVENT = 'INVENTORY_RESTORE'

/**
 * Decrements on-hand stock for each line once per order (idempotent).
 * Used when a sale is confirmed: pickup placement or Stripe payment.
 */
export async function deductOrderStock(order, { actorId = null } = {}) {
  if (!order?.id || !order.items?.length) return order

  const already = await prisma.orderEvent.findFirst({
    where: { orderId: order.id, type: DEDUCT_EVENT },
    select: { id: true },
  })
  if (already) return order

  const lines = order.items.filter((item) => item.variantId && item.qty > 0)
  if (!lines.length) return order

  await prisma.$transaction(async (tx) => {
    for (const item of lines) {
      const updated = await tx.variant.updateMany({
        where: { id: item.variantId, stock: { gte: item.qty } },
        data: { stock: { decrement: item.qty } },
      })

      if (updated.count === 0) {
        // Race / oversell after payment: never block fulfilment — clamp at zero.
        await tx.$executeRaw`
          UPDATE "Variant"
          SET stock = GREATEST(0, stock - ${item.qty})
          WHERE id = ${item.variantId}
        `
      }
    }

    await tx.orderEvent.create({
      data: {
        orderId: order.id,
        ...(actorId ? { actorId } : {}),
        type: DEDUCT_EVENT,
        message: `Inventory reduced for ${lines.length} line${lines.length === 1 ? '' : 's'}.`,
      },
    })
  })

  return order
}

/**
 * Restores stock once per order after cancel/refund (idempotent).
 * Only runs if inventory was previously deducted for this order.
 */
export async function restoreOrderStock(order, { actorId = null } = {}) {
  if (!order?.id || !order.items?.length) return order

  const deducted = await prisma.orderEvent.findFirst({
    where: { orderId: order.id, type: DEDUCT_EVENT },
    select: { id: true },
  })
  if (!deducted) return order

  const already = await prisma.orderEvent.findFirst({
    where: { orderId: order.id, type: RESTORE_EVENT },
    select: { id: true },
  })
  if (already) return order

  const lines = order.items.filter((item) => item.variantId && item.qty > 0)
  if (!lines.length) return order

  await prisma.$transaction(async (tx) => {
    for (const item of lines) {
      await tx.variant.updateMany({
        where: { id: item.variantId },
        data: { stock: { increment: item.qty } },
      })
    }

    await tx.orderEvent.create({
      data: {
        orderId: order.id,
        ...(actorId ? { actorId } : {}),
        type: RESTORE_EVENT,
        message: `Inventory restored for ${lines.length} line${lines.length === 1 ? '' : 's'}.`,
      },
    })
  })

  return order
}
