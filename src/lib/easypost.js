import EasyPostClient from '@easypost/api'
import { env } from './env.js'
import { HttpError } from './http-error.js'

let client = null

export function easypostEnabled() {
  return Boolean(env.easypost.apiKey)
}

function getClient() {
  if (!easypostEnabled()) {
    throw new HttpError(
      503,
      'Shipping rates are unavailable right now. Please choose warehouse pickup or contact support.',
    )
  }
  if (!client) {
    client = new EasyPostClient(
      env.easypost.apiKey,
      env.easypost.baseUrl ? { baseUrl: env.easypost.baseUrl } : undefined,
    )
  }
  return client
}

const BOTTLE_WEIGHT_OZ = 3
const SMALL_BOX = {
  maxBottles: 8,
  length: 6,
  width: 4,
  height: 2,
  baseWeightOz: 5,
}
const LARGE_BOX = {
  length: 9,
  width: 6,
  height: 4,
  baseWeightOz: 6,
}

/**
 * Builds the parcel supplied to EasyPost from Brett's packing rules.
 *
 * 1–8 bottles:  6 × 4 × 2 in, 5 oz box/packing + 3 oz per bottle.
 * 9+ bottles:   9 × 6 × 4 in, 6 oz box/packing + 3 oz per bottle.
 *
 * The large box is expected to hold up to 40 bottles. It remains the selected
 * tier above 40 so a quote is still available instead of silently dropping an
 * order; fulfillment can split unusually large orders when packing.
 */
export function buildParcel(items) {
  const bottleCount = items.reduce(
    (sum, item) => sum + Math.max(0, Number(item.qty) || 0),
    0,
  )
  const box = bottleCount <= SMALL_BOX.maxBottles ? SMALL_BOX : LARGE_BOX

  return {
    length: box.length,
    width: box.width,
    height: box.height,
    weight: box.baseWeightOz + BOTTLE_WEIGHT_OZ * bottleCount,
  }
}

function toEasyPostAddress(address) {
  return {
    name: address.name,
    company: address.company || undefined,
    street1: address.street1 || address.line1,
    street2: address.street2 || address.line2 || undefined,
    city: address.city,
    state: address.state,
    zip: address.zip,
    country: address.country || 'US',
    phone: address.phone || undefined,
    email: address.email || undefined,
  }
}

function normalizeRate(rate) {
  return {
    id: rate.id,
    carrier: rate.carrier,
    service: rate.service,
    // EasyPost returns rates as decimal strings.
    amountCents: Math.round(Number.parseFloat(rate.rate) * 100),
    currency: rate.currency || 'USD',
    deliveryDays: rate.delivery_days ?? rate.est_delivery_days ?? null,
    deliveryDate: rate.delivery_date ?? null,
  }
}

function normalizeToken(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

/**
 * Only expose tracked USPS / FedEx / UPS services Brett selected:
 * USPS Priority Mail, Ground Advantage, Priority Mail Express
 * FedEx Ground, Home Delivery, 2Day
 * UPS Ground, 3 Day Select, 2nd Day Air
 */
const ALLOWED_SHIPPING = {
  usps: ['priority', 'groundadvantage', 'express', 'prioritymailexpress', 'expressmail'],
  fedex: ['fedexground', 'ground', 'groundhomedelivery', 'homedelivery', 'fedex2day', '2day'],
  ups: ['ground', '3dayselect', '2nddayair', 'seconddayair'],
}

export function isAllowedShippingRate(rate) {
  const carrier = normalizeToken(rate?.carrier)
  const service = normalizeToken(rate?.service)
  if (!carrier || !service) return false

  if (carrier.includes('usps') || carrier === 'uspostal') {
    return ALLOWED_SHIPPING.usps.some((token) => service.includes(token) || token.includes(service))
  }
  if (carrier.includes('fedex')) {
    return ALLOWED_SHIPPING.fedex.some((token) => service.includes(token) || token.includes(service))
  }
  if (carrier.includes('ups')) {
    return ALLOWED_SHIPPING.ups.some((token) => service.includes(token) || token.includes(service))
  }
  return false
}

function carrierRank(carrier) {
  const token = normalizeToken(carrier)
  if (token.includes('usps') || token === 'uspostal') return 0
  if (token.includes('fedex')) return 1
  if (token.includes('ups')) return 2
  return 99
}

export function groupRatesByCarrier(rates) {
  const grouped = new Map()
  for (const rate of rates || []) {
    const token = normalizeToken(rate?.carrier)
    let label = 'Other'
    if (token.includes('usps') || token === 'uspostal') label = 'USPS'
    else if (token.includes('fedex')) label = 'FedEx'
    else if (token.includes('ups')) label = 'UPS'
    else label = rate?.carrier || 'Other'

    if (!grouped.has(label)) grouped.set(label, [])
    grouped.get(label).push(rate)
  }

  const order = ['USPS', 'FedEx', 'UPS']
  return order
    .filter((label) => grouped.has(label))
    .map((label) => ({
      carrier: label,
      rates: grouped.get(label).sort((a, b) => a.amountCents - b.amountCents),
    }))
}

function selectRates(rates) {
  return (rates || [])
    .map(normalizeRate)
    .filter((rate) => Number.isFinite(rate.amountCents) && isAllowedShippingRate(rate))
    .sort((a, b) => {
      const carrierDiff = carrierRank(a.carrier) - carrierRank(b.carrier)
      if (carrierDiff !== 0) return carrierDiff
      return a.amountCents - b.amountCents
    })
}

function readableError(error) {
  const message =
    error?.message ||
    error?.error?.message ||
    (Array.isArray(error?.errors) ? error.errors.map((e) => e.message).join(', ') : '')
  return message || 'The carrier could not be reached.'
}

export async function createShipmentWithRates({ toAddress, fromAddress, parcel }) {
  try {
    const shipment = await getClient().Shipment.create({
      to_address: toEasyPostAddress(toAddress),
      from_address: toEasyPostAddress(fromAddress),
      parcel,
    })

    const rates = selectRates(shipment.rates)

    if (!rates.length) {
      throw new HttpError(
        422,
        'No tracked USPS, FedEx, or UPS rates were available for that address. Double-check the address or choose warehouse pickup.',
      )
    }

    return { shipmentId: shipment.id, rates }
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(422, `Could not calculate shipping: ${readableError(error)}`)
  }
}

export async function buyLabel({ shipmentId, rateId }) {
  try {
    const shipment = await getClient().Shipment.retrieve(shipmentId)
    const rate = (shipment.rates || []).find((entry) => entry.id === rateId)
    if (!rate) {
      throw new HttpError(
        422,
        'That shipping rate has expired. Re-quote the shipment before buying a label.',
      )
    }
    if (!isAllowedShippingRate(rate)) {
      throw new HttpError(
        422,
        'That shipping service is not available. Please choose a tracked USPS, FedEx, or UPS option.',
      )
    }

    const bought = await getClient().Shipment.buy(shipmentId, rate)

    return {
      trackingCode: bought.tracking_code || null,
      trackingUrl: bought.tracker?.public_url || null,
      labelUrl: bought.postage_label?.label_url || null,
      carrier: rate.carrier,
      service: rate.service,
      amountCents: Math.round(Number.parseFloat(rate.rate) * 100),
    }
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(422, `Could not buy the shipping label: ${readableError(error)}`)
  }
}

/** Re-rates a stored shipment, used when a saved rate has gone stale. */
export async function refreshRates(shipmentId) {
  try {
    const shipment = await getClient().Shipment.retrieve(shipmentId)
    const rates = selectRates(shipment.rates)
    return { shipmentId: shipment.id, rates }
  } catch (error) {
    throw new HttpError(422, `Could not refresh shipping rates: ${readableError(error)}`)
  }
}
