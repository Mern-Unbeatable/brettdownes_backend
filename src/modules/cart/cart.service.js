import { prisma } from '../../lib/prisma.js'

const CART_INCLUDE = {
  variant: {
    include: {
      product: true,
    },
  },
}

export function serializeCartItem(entry) {
  const { variant } = entry
  return {
    productId: variant.productId,
    variantId: variant.id,
    slug: variant.product.slug,
    name: variant.product.name,
    dose: variant.dose,
    sku: variant.sku,
    price: variant.priceCents / 100,
    priceCents: variant.priceCents,
    image: variant.image || variant.product.image,
    qty: entry.qty,
  }
}

export async function getUserCart(userId) {
  const entries = await prisma.cartItem.findMany({
    where: {
      userId,
      variant: {
        isActive: true,
        product: { isActive: true },
      },
    },
    include: CART_INCLUDE,
    orderBy: { createdAt: 'asc' },
  })

  return entries.map(serializeCartItem)
}

export async function removePurchasedCartItems(userId, variantIds) {
  const ids = [...new Set((variantIds || []).filter(Boolean))]
  if (!userId || !ids.length) return

  await prisma.cartItem.deleteMany({
    where: {
      userId,
      variantId: { in: ids },
    },
  })
}
