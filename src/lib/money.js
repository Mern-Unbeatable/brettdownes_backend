/**
 * All monetary values are persisted and transported as integer cents so that
 * totals, Stripe amounts and EasyPost rates never round-trip through floats.
 */

export function toCents(value) {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return 0
  return Math.round(amount * 100)
}

export function toDollars(cents) {
  return Math.round(Number(cents) || 0) / 100
}

export function formatMoney(cents) {
  return `$${toDollars(cents).toFixed(2)}`
}
