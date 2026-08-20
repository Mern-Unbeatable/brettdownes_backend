import { prisma } from '../../lib/prisma.js'
import { badRequest } from '../../lib/http-error.js'

/**
 * Resolves client-supplied cart lines against the database. Prices, names and
 * parcel dimensions always come from the DB so the client cannot influence what
 * is charged or shipped.
 */
export async function resolveCart(lines) {
  if (!lines?.length) throw badRequest('Your cart is empty.')

  const variantIds = [...new Set(lines.map((line) => line.variantId))]
  const variants = await prisma.variant.findMany({
    where: { id: { in: variantIds } },
    include: { product: true },
  })

  const byId = new Map(variants.map((variant) => [variant.id, variant]))
  const items = []

  for (const line of lines) {
    const variant = byId.get(line.variantId)
    if (!variant) throw badRequest('One of the items in your cart is no longer available.')
    if (!variant.isActive || !variant.product.isActive) {
      throw badRequest(`${variant.product.name} (${variant.dose}) is no longer available.`)
    }

    const qty = Math.max(1, Math.trunc(Number(line.qty) || 1))

    items.push({
      variantId: variant.id,
      productId: variant.productId,
      productName: variant.product.name,
      slug: variant.product.slug,
      dose: variant.dose,
      barcode: variant.barcode,
      image: variant.image || variant.product.image,
      unitPriceCents: variant.priceCents,
      qty,
      weightOz: variant.weightOz,
      lengthIn: variant.lengthIn,
      widthIn: variant.widthIn,
      heightIn: variant.heightIn,
    })
  }

  const subtotalCents = items.reduce((sum, item) => sum + item.unitPriceCents * item.qty, 0)

  return { items, subtotalCents }
}

/** ORD-YYMMDD-XXXX, unique enough for a human-readable reference. */
export async function nextOrderNumber() {
  const stamp = new Date().toISOString().slice(2, 10).replace(/-/g, '')

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const suffix = Math.floor(1000 + Math.random() * 9000)
    const candidate = `ORD-${stamp}-${suffix}`
    const clash = await prisma.order.findUnique({
      where: { orderNumber: candidate },
      select: { id: true },
    })
    if (!clash) return candidate
  }

  return `ORD-${stamp}-${Date.now().toString().slice(-6)}`
}
