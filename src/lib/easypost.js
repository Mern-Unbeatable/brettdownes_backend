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

/**
 * Collapses a cart into one parcel: weights add up, and the box grows to the
 * largest footprint requested by any item.
 */
export function buildParcel(items, defaults) {
  const totalWeight = items.reduce(
    (sum, item) => sum + (Number(item.weightOz) || 0) * (Number(item.qty) || 1),
    0,
  )

  const length = Math.max(defaults.lengthIn, ...items.map((item) => item.lengthIn || 0))
  const width = Math.max(defaults.widthIn, ...items.map((item) => item.widthIn || 0))
  const height = Math.max(defaults.heightIn, ...items.map((item) => item.heightIn || 0))

  return {
    length,
    width,
    height,
    weight: Math.max(defaults.minWeightOz, Number(totalWeight.toFixed(2))),
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

    const rates = (shipment.rates || [])
      .map(normalizeRate)
      .filter((rate) => Number.isFinite(rate.amountCents))
      .sort((a, b) => a.amountCents - b.amountCents)

    if (!rates.length) {
      throw new HttpError(
        422,
        'No carrier rates were returned for that address. Double-check the address or choose warehouse pickup.',
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
    const rates = (shipment.rates || []).map(normalizeRate).sort((a, b) => a.amountCents - b.amountCents)
    return { shipmentId: shipment.id, rates }
  } catch (error) {
    throw new HttpError(422, `Could not refresh shipping rates: ${readableError(error)}`)
  }
}
