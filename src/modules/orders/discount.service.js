import { prisma } from '../../lib/prisma.js'
import { badRequest } from '../../lib/http-error.js'

/** A full kit is qty 10+ of one cart line, or any line explicitly labeled as a kit. */
function isKit(item) {
  if (Number(item.qty) >= 10) return true
  return /\bkit\b/i.test(`${item.productName || ''} ${item.dose || ''} ${item.sku || ''}`)
}

export async function getActiveDiscountTiers() {
  return prisma.discountTier.findMany({
    where: { enabled: true },
    orderBy: [{ minSubtotalCents: 'asc' }, { percent: 'asc' }],
  })
}

export function serializeDiscountTier(tier) {
  return {
    id: tier.id,
    enabled: tier.enabled,
    scope: tier.scope,
    percent: tier.percent,
    minSubtotalCents: tier.minSubtotalCents,
    detail: tier.name,
  }
}

export async function calculateCouponDiscount(items, code, { throwOnInvalid = true } = {}) {
  const normalized = String(code || '').trim().toUpperCase()
  if (!normalized) return null

  const coupon = await prisma.coupon.findUnique({
    where: { code: normalized },
    include: { products: { select: { productId: true } } },
  })
  const now = new Date()
  let reason = null
  if (!coupon || !coupon.enabled) reason = 'This coupon is not valid.'
  else if (coupon.startsAt && coupon.startsAt > now) reason = 'This coupon is not active yet.'
  else if (coupon.expiresAt && coupon.expiresAt < now) reason = 'This coupon has expired.'
  else if (coupon.usageLimit !== null && coupon.usageCount >= coupon.usageLimit) {
    reason = 'This coupon has reached its usage limit.'
  }

  const subtotalCents = items.reduce((sum, item) => sum + item.unitPriceCents * item.qty, 0)
  if (!reason && subtotalCents < coupon.minSubtotalCents) {
    reason = `This coupon requires a minimum order of $${(coupon.minSubtotalCents / 100).toFixed(2)}.`
  }

  const productIds = new Set((coupon?.products || []).map((entry) => entry.productId))
  const eligibleSubtotalCents = !coupon
    ? 0
    : items
        .filter((item) => coupon.appliesTo === 'ALL' || productIds.has(item.productId))
        .reduce((sum, item) => sum + item.unitPriceCents * item.qty, 0)

  if (!reason && !eligibleSubtotalCents) reason = 'This coupon does not apply to items in your cart.'
  if (reason) {
    if (throwOnInvalid) throw badRequest(reason)
    return { valid: false, message: reason }
  }

  const discountCents =
    coupon.discountType === 'FIXED'
      ? Math.min(eligibleSubtotalCents, coupon.discountValue)
      : Math.round(eligibleSubtotalCents * (coupon.discountValue / 100))

  return {
    valid: true,
    couponId: coupon.id,
    code: coupon.code,
    discountCents,
    discountLabel: `Coupon ${coupon.code}`,
    description: coupon.description,
  }
}

/**
 * Calculates every eligible reward and applies only the one producing the
 * largest discount. ORDER rewards affect the entire subtotal; KIT rewards
 * affect full-kit lines only (qty 10+ of one item, or items labeled as a kit).
 */
export function calculateBulkDiscount(items, tiers = []) {
  const subtotalCents = items.reduce(
    (sum, item) => sum + item.unitPriceCents * item.qty,
    0,
  )
  const kitSubtotalCents = items
    .filter(isKit)
    .reduce((sum, item) => sum + item.unitPriceCents * item.qty, 0)

  let best = { discountCents: 0, discountLabel: null, tierId: null }

  for (const tier of tiers || []) {
    if (!tier?.enabled || !tier.percent) continue

    const baseCents = tier.scope === 'KIT' ? kitSubtotalCents : subtotalCents
    if (!baseCents || baseCents < Number(tier.minSubtotalCents || 0)) continue

    const discountCents = Math.round(baseCents * (Number(tier.percent) / 100))
    if (discountCents > best.discountCents) {
      best = {
        discountCents,
        discountLabel: `${tier.percent}% — ${tier.detail}`,
        tierId: tier.id,
      }
    }
  }

  return best
}
