import * as XLSX from 'xlsx'
import { prisma } from '../../lib/prisma.js'
import { badRequest } from '../../lib/http-error.js'
import { buildParcel } from '../../lib/easypost.js'
import { sendMail } from '../../lib/mailer.js'
import { templates } from '../../lib/email-templates.js'
import { ORDER_INCLUDE, serializeOrder } from './order.serializer.js'

/** Paid delivery orders waiting for a Pirate Ship label and tracking number. */
export function newOrderWhere() {
  return {
    fulfillment: 'DELIVERY',
    paymentStatus: 'PAID',
    trackingCode: null,
    status: { notIn: ['CANCELLED', 'REFUNDED'] },
  }
}

export async function listNewOrders() {
  const orders = await prisma.order.findMany({
    where: newOrderWhere(),
    include: ORDER_INCLUDE,
    orderBy: { createdAt: 'asc' },
  })

  return orders.map((order, index) => serializeNewOrder(order, index + 1))
}

function parcelFields(order) {
  const parcel = buildParcel(order.items || [])
  return {
    length: parcel.length,
    width: parcel.width,
    height: parcel.height,
    weightOz: parcel.weight,
  }
}

export function serializeNewOrder(order, queueNumber) {
  return {
    ...serializeOrder(order),
    queueNumber,
    parcel: parcelFields(order),
  }
}

export function withParcel(order, serialized) {
  if (!order || order.fulfillment !== 'DELIVERY' || serialized.parcel) return serialized
  return { ...serialized, parcel: parcelFields(order) }
}

export async function queueNumberFor(order) {
  if (!order || order.fulfillment !== 'DELIVERY' || order.trackingCode) return null
  if (order.paymentStatus !== 'PAID') return null
  if (order.status === 'CANCELLED' || order.status === 'REFUNDED') return null

  const ahead = await prisma.order.count({
    where: {
      ...newOrderWhere(),
      createdAt: { lt: order.createdAt },
    },
  })
  return ahead + 1
}

export function trackingUrlFor(carrier, trackingCode) {
  const code = encodeURIComponent(String(trackingCode || '').trim())
  if (!code) return null
  const token = String(carrier || '').toLowerCase()
  if (token.includes('usps') || token.includes('postal')) {
    return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${code}`
  }
  if (token.includes('fedex')) {
    return `https://www.fedex.com/fedextrack/?trknbr=${code}`
  }
  if (token.includes('ups')) {
    return `https://www.ups.com/track?loc=en_US&tracknum=${code}`
  }
  return null
}

function carrierLabel(carrier, trackingCode) {
  const token = String(carrier || '').toLowerCase()
  const code = String(trackingCode || '').trim()
  if (token.includes('usps') || token.includes('postal') || /^(94|93|92|91)\d{18,}$/.test(code)) {
    return 'USPS'
  }
  if (token.includes('fedex')) return 'FedEx'
  if (token.includes('ups') || /^1Z/i.test(code)) return 'UPS'
  return 'Carrier'
}

export function inferCarrier(trackingCode, carrier) {
  const given = String(carrier || '').trim()
  if (given) return given
  const raw = String(trackingCode || '').trim()
  if (/^1Z/i.test(raw)) return 'UPS'
  if (/^(94|93|92|91)\d{18,}$/.test(raw)) return 'USPS'
  return ''
}

export function buildPirateShipSheet(orders) {
  const rows = orders.map((order) => ({
    Name: order.contactName,
    Email: order.contactEmail,
    Phone: order.contactPhone,
    'Address Line 1': order.address?.line1 || '',
    'Address Line 2': order.address?.line2 || '',
    City: order.address?.city || '',
    State: order.address?.state || '',
    Zip: order.address?.zip || '',
    Country: order.address?.country || 'US',
    Length: order.parcel?.length ?? '',
    Width: order.parcel?.width ?? '',
    Height: order.parcel?.height ?? '',
    'Weight (ounces)': order.parcel?.weightOz ?? '',
    'Order Number': order.orderNumber,
    'Shipping Method': [order.carrier, order.service].filter(Boolean).join(' '),
  }))

  const sheet = XLSX.utils.json_to_sheet(rows)
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, sheet, 'Addresses')
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' })
}

function headerKey(keys, pattern) {
  return keys.find((key) => pattern.test(String(key || '').trim()))
}

function readSheetRows(buffer) {
  const book = XLSX.read(buffer, { type: 'buffer' })
  const sheet = book.Sheets[book.SheetNames[0]]
  if (!sheet) throw badRequest('The spreadsheet is empty.')
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' })
  if (!rows.length) throw badRequest('The spreadsheet has no data rows.')
  return rows
}

/**
 * Saves a pasted Pirate Ship tracking number and marks the delivery order shipped.
 */
export async function applyManualTracking(existing, trackingCode, { actorId, carrierHint } = {}) {
  const code = String(trackingCode || '').trim()
  if (!code) throw badRequest('Paste a tracking number.')
  if (existing.fulfillment !== 'DELIVERY') {
    throw badRequest('Pickup orders do not use a carrier tracking number.')
  }
  if (existing.paymentStatus !== 'PAID') throw badRequest('This order is not paid yet.')
  if (existing.status === 'CANCELLED' || existing.status === 'REFUNDED') {
    throw badRequest(`This order is ${existing.status.toLowerCase()}.`)
  }
  if (existing.trackingCode) {
    throw badRequest(`This order already has tracking ${existing.trackingCode}.`)
  }

  const carrier = inferCarrier(code, carrierHint || existing.carrier)
  const trackingUrl = trackingUrlFor(carrier, code)
  const updated = await prisma.order.update({
    where: { id: existing.id },
    data: {
      trackingCode: code,
      trackingUrl,
      ...(carrier && !existing.carrier ? { carrier } : {}),
      status: 'SHIPPED',
      shippedAt: existing.shippedAt || new Date(),
      events: {
        create: {
          actorId: actorId || null,
          type: 'TRACKING',
          message: `${carrierLabel(carrier, code)} tracking ${code} added. Order marked shipped.`,
        },
      },
    },
    include: ORDER_INCLUDE,
  })

  sendMail({ to: updated.contactEmail, ...templates.orderShipped(updated) })
  return updated
}

/**
 * Applies tracking numbers from an admin spreadsheet.
 * Required columns: Order Number, Tracking Number. Carrier is optional.
 */
export async function applyTrackingSheet(buffer, { actorId } = {}) {
  const rows = readSheetRows(buffer)
  const keys = Object.keys(rows[0] || {})
  const orderKey = headerKey(keys, /order/i)
  const trackingKey = headerKey(keys, /track/i)
  const carrierKey = headerKey(keys, /carrier|service/i)

  if (!orderKey || !trackingKey) {
    throw badRequest('The spreadsheet needs an Order Number column and a Tracking Number column.')
  }

  const applied = []
  const errors = []

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    const orderNumber = String(row[orderKey] || '').trim()
    const trackingCode = String(row[trackingKey] || '').trim()
    const rowNumber = index + 2

    if (!orderNumber && !trackingCode) continue
    if (!orderNumber || !trackingCode) {
      errors.push(`Row ${rowNumber}: both Order Number and Tracking Number are required.`)
      continue
    }

    const existing = await prisma.order.findFirst({
      where: { orderNumber: { equals: orderNumber, mode: 'insensitive' } },
      include: ORDER_INCLUDE,
    })
    if (!existing) {
      errors.push(`Row ${rowNumber}: order ${orderNumber} was not found.`)
      continue
    }

    try {
      await applyManualTracking(existing, trackingCode, {
        actorId,
        carrierHint: row[carrierKey] || existing.carrier,
      })
      applied.push(existing.orderNumber)
    } catch (error) {
      errors.push(`Row ${rowNumber}: ${error.message}`)
    }
  }

  if (!applied.length && errors.length) {
    throw badRequest(errors[0])
  }

  return { applied, errors }
}
