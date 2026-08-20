import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound } from '../../lib/http-error.js'
import { toCents, toDollars } from '../../lib/money.js'

function serializeVariant(variant) {
  return {
    id: variant.id,
    dose: variant.dose,
    price: toDollars(variant.priceCents),
    priceCents: variant.priceCents,
    barcode: variant.barcode,
    image: variant.image,
    stock: variant.stock,
    quantity: variant.stock,
    weightOz: variant.weightOz,
    lengthIn: variant.lengthIn,
    widthIn: variant.widthIn,
    heightIn: variant.heightIn,
    isActive: variant.isActive,
    sortOrder: variant.sortOrder,
  }
}

function serializeProduct(product) {
  return {
    id: product.id,
    slug: product.slug,
    name: product.name,
    category: product.category,
    summary: product.summary,
    description: product.description,
    purity: product.purity,
    form: product.form,
    image: product.image,
    highlights: product.highlights,
    badge: product.badge,
    showOnHome: product.showOnHome,
    homeOrder: product.homeOrder,
    isActive: product.isActive,
    sortOrder: product.sortOrder,
    createdAt: product.createdAt,
    variants: (product.variants || []).map(serializeVariant),
  }
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

async function uniqueSlug(base, ignoreId) {
  const root = slugify(base) || 'product'
  let candidate = root
  let suffix = 2

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const clash = await prisma.product.findFirst({
      where: { slug: candidate, ...(ignoreId ? { NOT: { id: ignoreId } } : {}) },
      select: { id: true },
    })
    if (!clash) return candidate
    candidate = `${root}-${suffix++}`
  }
}

async function assertBarcodeAvailable(barcode, ignoreId) {
  const value = String(barcode || '').trim()
  if (!value) throw badRequest('Every variant needs a barcode.')
  const clash = await prisma.variant.findFirst({
    where: {
      barcode: { equals: value, mode: 'insensitive' },
      ...(ignoreId ? { NOT: { id: ignoreId } } : {}),
    },
    select: { barcode: true },
  })
  if (clash) throw badRequest(`Barcode "${value}" is already used.`)
  return value
}

async function variantCreateData(input) {
  const { price, barcode, ...rest } = input
  return {
    ...rest,
    priceCents: toCents(price),
    barcode: await assertBarcodeAvailable(barcode),
  }
}

async function assertHomepageSelection(showOnHome, homeOrder, ignoreId) {
  if (!showOnHome) return
  const whereOther = {
    showOnHome: true,
    ...(ignoreId ? { NOT: { id: ignoreId } } : {}),
  }
  const [selected, positionTaken] = await Promise.all([
    prisma.product.count({ where: whereOther }),
    prisma.product.findFirst({
      where: { ...whereOther, homeOrder },
      select: { name: true },
    }),
  ])
  if (selected >= 4) {
    throw badRequest('Only four products can be selected for the homepage. Remove one first.')
  }
  if (positionTaken) {
    throw badRequest(`Homepage position ${homeOrder + 1} is already used by ${positionTaken.name}.`)
  }
}

const ACTIVE_VARIANTS = {
  where: { isActive: true },
  orderBy: [{ sortOrder: 'asc' }, { priceCents: 'asc' }],
}

/** Top 4 by units sold on paid orders; fill with catalogue order if sales are thin. */
async function getBestSellingProducts(limit = 4) {
  const sold = await prisma.orderItem.groupBy({
    by: ['variantId'],
    where: {
      variantId: { not: null },
      order: { paymentStatus: 'PAID' },
    },
    _sum: { qty: true },
    orderBy: { _sum: { qty: 'desc' } },
    take: 40,
  })

  const variantIds = sold.map((row) => row.variantId).filter(Boolean)
  const variants = variantIds.length
    ? await prisma.variant.findMany({
        where: { id: { in: variantIds }, isActive: true, product: { isActive: true } },
        select: { id: true, productId: true },
      })
    : []
  const productByVariant = new Map(variants.map((variant) => [variant.id, variant.productId]))

  const rankedIds = []
  const seen = new Set()
  for (const row of sold) {
    const productId = productByVariant.get(row.variantId)
    if (!productId || seen.has(productId)) continue
    seen.add(productId)
    rankedIds.push(productId)
    if (rankedIds.length >= limit) break
  }

  if (rankedIds.length < limit) {
    const fillers = await prisma.product.findMany({
      where: { isActive: true, ...(seen.size ? { id: { notIn: [...seen] } } : {}) },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      take: limit - rankedIds.length,
      select: { id: true },
    })
    for (const product of fillers) rankedIds.push(product.id)
  }

  if (!rankedIds.length) return []

  const products = await prisma.product.findMany({
    where: { id: { in: rankedIds }, isActive: true },
    include: { variants: ACTIVE_VARIANTS },
  })
  const byId = new Map(products.map((product) => [product.id, product]))
  return rankedIds.map((id) => byId.get(id)).filter(Boolean)
}

/**
 * Homepage grid: admin-selected featured products (max 4), or best sellers
 * from paid orders when none are selected.
 */
export async function listFeaturedProducts(req, res) {
  const featured = await prisma.product.findMany({
    where: { isActive: true, showOnHome: true },
    include: { variants: ACTIVE_VARIANTS },
    orderBy: [{ homeOrder: 'asc' }, { sortOrder: 'asc' }],
    take: 4,
  })

  if (featured.length) {
    return res.json({
      source: 'featured',
      products: featured.map(serializeProduct),
    })
  }

  const bestsellers = await getBestSellingProducts(4)
  res.json({
    source: 'bestsellers',
    products: bestsellers.map(serializeProduct),
  })
}

export async function listProducts(req, res) {
  const query = req.validatedQuery || {}
  const isAdmin = req.user?.role === 'ADMIN'
  const includeInactive = isAdmin && query.includeInactive

  const products = await prisma.product.findMany({
    where: {
      ...(includeInactive ? {} : { isActive: true }),
      ...(query.category ? { category: query.category } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { summary: { contains: query.search, mode: 'insensitive' } },
              { category: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    include: {
      variants: {
        where: includeInactive ? {} : { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { priceCents: 'asc' }],
      },
    },
    orderBy: [{ name: 'asc' }],
  })

  res.json({ products: products.map(serializeProduct) })
}

export async function getProduct(req, res) {
  const { slug } = req.params
  const isAdmin = req.user?.role === 'ADMIN'

  const product = await prisma.product.findFirst({
    where: { OR: [{ slug }, { id: slug }], ...(isAdmin ? {} : { isActive: true }) },
    include: {
      variants: {
        where: isAdmin ? {} : { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { priceCents: 'asc' }],
      },
    },
  })

  if (!product) throw notFound('Product not found.')
  res.json({ product: serializeProduct(product) })
}

export async function createProduct(req, res) {
  const { variants, slug, ...rest } = req.body
  await assertHomepageSelection(rest.showOnHome, rest.homeOrder)

  const providedBarcodes = variants.map((variant) => String(variant.barcode || '').trim())
  if (providedBarcodes.some((barcode) => !barcode)) {
    throw badRequest('Every variant needs a barcode.')
  }
  if (new Set(providedBarcodes.map((value) => value.toLowerCase())).size !== providedBarcodes.length) {
    throw badRequest('Variant barcodes must be unique.')
  }
  for (const barcode of providedBarcodes) {
    await assertBarcodeAvailable(barcode)
  }

  const product = await prisma.product.create({
    data: {
      ...rest,
      slug: await uniqueSlug(slug || rest.name),
      variants: {
        create: await Promise.all(variants.map((variant) => variantCreateData(variant))),
      },
    },
    include: { variants: { orderBy: { sortOrder: 'asc' } } },
  })

  res.status(201).json({ product: serializeProduct(product) })
}

export async function updateProduct(req, res) {
  const { id } = req.params
  const existing = await prisma.product.findUnique({ where: { id } })
  if (!existing) throw notFound('Product not found.')

  const { slug, ...rest } = req.body
  await assertHomepageSelection(rest.showOnHome, rest.homeOrder, id)
  const data = { ...rest }
  if (slug && slug !== existing.slug) data.slug = await uniqueSlug(slug, id)

  const product = await prisma.product.update({
    where: { id },
    data,
    include: { variants: { orderBy: [{ sortOrder: 'asc' }, { priceCents: 'asc' }] } },
  })

  res.json({ product: serializeProduct(product) })
}

export async function deleteProduct(req, res) {
  const { id } = req.params
  const existing = await prisma.product.findUnique({ where: { id } })
  if (!existing) throw notFound('Product not found.')

  await prisma.product.delete({ where: { id } })
  res.json({ ok: true })
}

export async function createVariant(req, res) {
  const { id } = req.params
  const product = await prisma.product.findUnique({ where: { id } })
  if (!product) throw notFound('Product not found.')

  const variant = await prisma.variant.create({
    data: { ...(await variantCreateData(req.body)), productId: id },
  })

  res.status(201).json({ variant: serializeVariant(variant) })
}

export async function updateVariant(req, res) {
  const { variantId } = req.params
  const existing = await prisma.variant.findUnique({ where: { id: variantId } })
  if (!existing) throw notFound('Variant not found.')

  const { price, barcode, ...rest } = req.body
  const data = { ...rest }
  if (price !== undefined) data.priceCents = toCents(price)
  if (barcode !== undefined) data.barcode = await assertBarcodeAvailable(barcode, variantId)

  const variant = await prisma.variant.update({ where: { id: variantId }, data })
  res.json({ variant: serializeVariant(variant) })
}

export async function deleteVariant(req, res) {
  const { variantId } = req.params
  const existing = await prisma.variant.findUnique({ where: { id: variantId } })
  if (!existing) throw notFound('Variant not found.')

  const siblings = await prisma.variant.count({ where: { productId: existing.productId } })
  if (siblings <= 1) throw badRequest('A product must keep at least one variant.')

  await prisma.variant.delete({ where: { id: variantId } })
  res.json({ ok: true })
}

export { serializeProduct, serializeVariant, uniqueSlug, slugify }
