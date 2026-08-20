import { toDollars } from '../../lib/money.js'

export const ORDER_INCLUDE = {
  items: true,
  events: { orderBy: { createdAt: 'desc' } },
  user: { select: { id: true, name: true, email: true, company: true } },
}

/** List views only need line items — skips events/user and saves a remote DB RTT. */
export const ORDER_LIST_INCLUDE = {
  items: true,
}

export function serializeOrder(order) {
  const isPickup = order.fulfillment === 'PICKUP'
  const pickupLines = isPickup
    ? String(order.addressLine2 || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    : []

  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    paymentStatus: order.paymentStatus,
    paymentMethod: order.paymentMethod,
    fulfillment: order.fulfillment,

    subtotalCents: order.subtotalCents,
    discountCents: order.discountCents || 0,
    discountLabel: order.discountLabel || null,
    couponCode: order.couponCode || null,
    shippingCents: order.shippingCents,
    totalCents: order.totalCents,
    subtotal: toDollars(order.subtotalCents),
    discount: toDollars(order.discountCents || 0),
    shipping: toDollars(order.shippingCents),
    total: toDollars(order.totalCents),
    currency: order.currency,

    contactName: order.contactName,
    contactEmail: order.contactEmail,
    contactPhone: order.contactPhone,
    address:
      !isPickup && order.addressLine1
        ? {
            line1: order.addressLine1,
            line2: order.addressLine2,
            city: order.city,
            state: order.state,
            zip: order.zip,
            country: order.country,
          }
        : null,
    pickupLocation:
      isPickup && order.addressLine1
        ? {
            name: order.addressLine1,
            lines: pickupLines,
          }
        : null,
    notes: order.notes,

    carrier: order.carrier,
    service: order.service,
    trackingCode: order.trackingCode,
    trackingUrl: order.trackingUrl,
    labelUrl: order.labelUrl,
    hasLabel: Boolean(order.labelUrl),
    canBuyLabel: Boolean(order.easypostShipmentId && order.easypostRateId && !order.labelUrl),

    paidAt: order.paidAt,
    shippedAt: order.shippedAt,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,

    customer: order.user
      ? { id: order.user.id, name: order.user.name, email: order.user.email, company: order.user.company }
      : null,

    items: (order.items || []).map((item) => ({
      id: item.id,
      variantId: item.variantId,
      productName: item.productName,
      dose: item.dose,
      barcode: item.barcode,
      image: item.image,
      qty: item.qty,
      unitPriceCents: item.unitPriceCents,
      unitPrice: toDollars(item.unitPriceCents),
      lineTotalCents: item.unitPriceCents * item.qty,
      lineTotal: toDollars(item.unitPriceCents * item.qty),
    })),

    events: (order.events || []).map((event) => ({
      id: event.id,
      type: event.type,
      message: event.message,
      createdAt: event.createdAt,
    })),
  }
}
