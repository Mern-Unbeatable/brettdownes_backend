export const SETTINGS_KEY = 'site'

export const DEFAULT_SETTINGS = {
  // Registration
  autoApproval: false,
  adminNotifyEmails: ['Support@peptideopslogistics.com'],
  notifyNewRegistration: true,
  notifyNewOrder: true,

  // Checkout copy
  deliveryNote:
    'Orders ship discreetly from our Keizer, OR facility within 1-2 business days. Live carrier rates are calculated at checkout from USPS, UPS and FedEx. A tracking number is emailed as soon as your label is created. For Research Use Only; Not for Human Consumption.',
  pickupNote:
    'Bring your order confirmation email and a photo ID. Pickup orders are paid at the warehouse — no card is charged online.',
  paymentDescriptorNote:
    'Heads up: this transaction will appear on your bank statement as "That 3D Printer Guy" — not Peptide Ops Logistics.',

  // Stripe statement descriptor suffix. Stripe caps this at 22 characters.
  statementDescriptor: 'That 3D Printer Guy',

  shipFrom: {
    name: 'Peptide Ops Logistics',
    company: 'Peptide Ops Logistics',
    street1: '4472 River Rd N',
    street2: 'PMB #1020',
    city: 'Keizer',
    state: 'OR',
    zip: '97303',
    country: 'US',
    phone: '5038775390',
    email: 'Support@peptideopslogistics.com',
  },

  // Legacy single location — kept for older rows; getSettings maps this into pickupLocations.
  pickupAddress: {
    name: 'Peptide Ops Logistics',
    lines: ['4472 River Rd N', 'PMB #1020', 'Keizer, OR 97303'],
  },

  pickupLocations: [
    {
      id: 'default-keizer',
      name: 'Peptide Ops Logistics',
      lines: ['4472 River Rd N', 'PMB #1020', 'Keizer, OR 97303'],
    },
  ],

  // Fallback parcel used when variants have no dimensions of their own.
  defaultParcel: {
    lengthIn: 6,
    widthIn: 4,
    heightIn: 2,
    minWeightOz: 3,
  },

  handlingFeeCents: 0,
  freeShippingThresholdCents: 0,
}

function cleanLocation(entry, index = 0) {
  const name = String(entry?.name || '').trim() || `Pickup location ${index + 1}`
  const lines = Array.isArray(entry?.lines)
    ? entry.lines.map((line) => String(line || '').trim()).filter(Boolean).slice(0, 6)
    : []
  const id = String(entry?.id || '').trim() || `loc-${index + 1}`
  return { id, name, lines }
}

/** Prefer pickupLocations; fall back to legacy pickupAddress / defaults. */
export function resolvePickupLocations(stored = {}) {
  if (Array.isArray(stored.pickupLocations) && stored.pickupLocations.length > 0) {
    return stored.pickupLocations.map((entry, index) => cleanLocation(entry, index))
  }

  const legacy = stored.pickupAddress || DEFAULT_SETTINGS.pickupAddress
  return [cleanLocation({ id: 'legacy-default', ...legacy }, 0)]
}

/** Public subset safe to expose to the storefront. */
export function toPublicSettings(settings, extra = {}) {
  const pickupLocations = resolvePickupLocations(settings)
  return {
    deliveryNote: settings.deliveryNote,
    pickupNote: settings.pickupNote,
    paymentDescriptorNote: settings.paymentDescriptorNote,
    statementDescriptor: settings.statementDescriptor,
    pickupAddress: pickupLocations[0],
    pickupLocations,
    freeShippingThresholdCents: settings.freeShippingThresholdCents,
    ...extra,
  }
}
