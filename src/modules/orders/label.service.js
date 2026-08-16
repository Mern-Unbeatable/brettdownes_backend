import { prisma } from '../../lib/prisma.js'
import { badRequest } from '../../lib/http-error.js'
import { buildParcel, buyLabel, createShipmentWithRates } from '../../lib/easypost.js'
import { sendMail } from '../../lib/mailer.js'
import { templates } from '../../lib/email-templates.js'
import { getSettings } from '../settings/settings.service.js'
import { ORDER_INCLUDE } from './order.serializer.js'

function sameService(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase()
}

function pickRate(rates, { rateId, carrier, service }) {
  return (
    rates.find((rate) => rate.id === rateId) ||
    rates.find((rate) => sameService(rate.carrier, carrier) && sameService(rate.service, service)) ||
    rates.find((rate) => sameService(rate.service, service)) ||
    null
  )
}

/**
 * Buys the customer-selected EasyPost rate (or the same carrier/service after a
 * fresh quote when the original rate expired). Marks the order shipped.
 */
export async function purchaseOrderLabel(order, { actorId = null } = {}) {
  if (order.fulfillment !== 'DELIVERY') {
    throw badRequest('Pickup orders do not need a shipping label.')
  }
  if (order.labelUrl) {
    throw badRequest('A label has already been purchased for this order.')
  }
  if (order.paymentStatus !== 'PAID') {
    throw badRequest('Buy the shipping label only after payment is confirmed.')
  }
  if (!order.addressLine1) {
    throw badRequest('This order has no delivery address.')
  }

  let shipmentId = order.easypostShipmentId
  let rateId = order.easypostRateId
  let carrier = order.carrier
  let service = order.service
  let label = null

  try {
    if (!shipmentId || !rateId) {
      throw new Error('Missing shipment quote')
    }
    label = await buyLabel({ shipmentId, rateId })
  } catch {
    const settings = await getSettings()
    const items =
      order.items ||
      (await prisma.orderItem.findMany({ where: { orderId: order.id } }))
    const quoted = await createShipmentWithRates({
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
      parcel: buildParcel(items),
    })

    const matched = pickRate(quoted.rates, { rateId, carrier, service })
    if (!matched) {
      throw badRequest(
        'The original carrier rate expired and no matching service is available for a fresh quote.',
      )
    }

    shipmentId = quoted.shipmentId
    rateId = matched.id
    carrier = matched.carrier
    service = matched.service
    label = await buyLabel({ shipmentId, rateId })
  }

  const updated = await prisma.order.update({
    where: { id: order.id },
    data: {
      labelUrl: label.labelUrl,
      trackingCode: label.trackingCode,
      trackingUrl: label.trackingUrl,
      carrier: label.carrier || carrier,
      service: label.service || service,
      easypostShipmentId: shipmentId,
      easypostRateId: rateId,
      status: 'SHIPPED',
      shippedAt: new Date(),
      events: {
        create: {
          ...(actorId ? { actorId } : {}),
          type: 'LABEL',
          message: `${label.carrier} ${label.service} label purchased automatically${
            label.trackingCode ? ` (tracking ${label.trackingCode})` : ''
          }.`,
        },
      },
    },
    include: ORDER_INCLUDE,
  })

  sendMail({ to: updated.contactEmail, ...templates.orderShipped(updated) })
  return updated
}
