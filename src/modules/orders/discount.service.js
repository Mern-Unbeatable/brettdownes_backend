import { prisma } from '../../lib/prisma.js'
import { badRequest } from '../../lib/http-error.js'
import { isKitDiscountCategory } from '../products/product.schemas.js'

/** Explicit kit label, or qty 10+ of one cart line — Peptides & Blends only. */
function isKit(item) {
  if (!isKitDiscountCategory(item.category)) return false
  // Safety net: bacteriostatic water never gets kit pricing even if miscategorized.
  if (
    /bacteriostatic/i.test(
      `${item.productName || item.name || ''} ${item.dose || ''} ${item.barcode || ''}`,
    )
  ) {
    return false
  }
  if (Number(item.qty) >= 10) return true
  return /\bkit\b/i.test(
    `${item.productName || item.name || ''} ${item.dose || ''} ${item.barcode || ''}`,
  )
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
 * affect full-kit lines only (qty 10+ / kit-labeled), limited to Peptides
 * and Blends — never Other (e.g. bacteriostatic water).
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

function isPromotionActive(promotion, now = new Date()) {
  if (!promotion?.enabled) return false
  if (promotion.startsAt && promotion.startsAt > now) return false
  if (promotion.expiresAt && promotion.expiresAt < now) return false
  return true
}

/**
 * Pair eligible units highest-to-lowest; the cheaper item in each pair is free
 * (mix & match across selected products).
 */
export function calculateBogoDiscountForProducts(items, productIds, label = 'BOGO') {
  const idSet = productIds instanceof Set ? productIds : new Set(productIds || [])
  if (!idSet.size) return { discountCents: 0, discountLabel: null }

  const units = []
  for (const item of items || []) {
    if (!idSet.has(item.productId)) continue
    const unitPriceCents = Number(item.unitPriceCents)
    if (!Number.isFinite(unitPriceCents) || unitPriceCents <= 0) continue
    for (let i = 0; i < Number(item.qty) || 0; i += 1) {
      units.push(unitPriceCents)
    }
  }

  if (units.length < 2) return { discountCents: 0, discountLabel: null }

  units.sort((a, b) => b - a)
  let discountCents = 0
  for (let i = 1; i < units.length; i += 2) {
    discountCents += units[i]
  }

  return { discountCents, discountLabel: label }
}

export async function getActiveBogoPromotions(now = new Date()) {
  const promos = await prisma.bogoPromotion.findMany({
    where: { enabled: true },
    include: { products: { select: { productId: true } } },
    orderBy: { createdAt: 'asc' },
  })
  return promos.filter((promo) => isPromotionActive(promo, now))
}

export function serializeBogoPromotion(promotion) {
  return {
    id: promotion.id,
    name: promotion.name,
    enabled: promotion.enabled,
    startsAt: promotion.startsAt,
    expiresAt: promotion.expiresAt,
    productIds: (promotion.products || []).map((entry) => entry.productId),
  }
}

export async function calculateBogoDiscount(items, now = new Date()) {
  const promos = await getActiveBogoPromotions(now)
  let discountCents = 0
  const labels = []

  for (const promo of promos) {
    const productIds = promo.products.map((entry) => entry.productId)
    const result = calculateBogoDiscountForProducts(items, productIds, promo.name)
    if (result.discountCents > 0) {
      discountCents += result.discountCents
      labels.push(result.discountLabel)
    }
  }

  return {
    discountCents,
    discountLabel: labels.length ? labels.join(' + ') : null,
  }
}

/** Largest automatic discount wins (bulk tier vs BOGO). Coupons may still stack. */
export function pickAutomaticDiscount(bulkDiscount, bogoDiscount) {
  const bulk = bulkDiscount?.discountCents || 0
  const bogo = bogoDiscount?.discountCents || 0
  if (bogo > bulk) return bogoDiscount
  return bulkDiscount
}
