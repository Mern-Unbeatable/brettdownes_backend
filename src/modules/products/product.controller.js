import crypto from 'node:crypto'
import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound } from '../../lib/http-error.js'
import { toCents, toDollars } from '../../lib/money.js'

function serializeVariant(variant) {
  return {
    id: variant.id,
    dose: variant.dose,
    price: toDollars(variant.priceCents),
    priceCents: variant.priceCents,
    sku: variant.sku,
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

/** Internal inventory code — never required from admins or the spreadsheet. */
async function uniqueSku(seed = 'PO') {
  const root = slugify(seed).slice(0, 24).toUpperCase() || 'PO'
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = `${root}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`
    const clash = await prisma.variant.findUnique({ where: { sku: candidate }, select: { id: true } })
    if (!clash) return candidate
  }
  return `${root}-${Date.now().toString(36).toUpperCase()}`
}

async function variantCreateData(input) {
  const { price, sku, ...rest } = input
  return {
    ...rest,
    priceCents: toCents(price),
    sku: sku?.trim() ? sku.trim() : await uniqueSku(`${rest.dose || 'VAR'}`),
  }
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
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
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

  const providedSkus = variants.map((variant) => variant.sku?.trim()).filter(Boolean)
  if (new Set(providedSkus.map((value) => value.toLowerCase())).size !== providedSkus.length) {
    throw badRequest('Variant SKUs must be unique.')
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

  const { price, sku, ...rest } = req.body
  const data = { ...rest }
  if (price !== undefined) data.priceCents = toCents(price)
  if (sku?.trim()) data.sku = sku.trim()

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

export { serializeProduct, serializeVariant, uniqueSlug, uniqueSku, slugify }
