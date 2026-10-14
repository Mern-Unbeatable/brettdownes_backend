import bcrypt from 'bcryptjs'
import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound, unauthorized } from '../../lib/http-error.js'
import { toCents, toDollars } from '../../lib/money.js'

const WHOLESALE_SETTINGS_KEY = 'wholesale'
/** Fallback access password used until an admin changes it. */
export const DEFAULT_WHOLESALE_PASSWORD = 'wholesale2026'

function slugify(value) {
  return (
    String(value || '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'category'
  )
}

async function uniqueCategorySlug(base, ignoreId) {
  const root = slugify(base)
  let candidate = root
  let suffix = 2
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const clash = await prisma.wholesaleCategory.findFirst({
      where: { slug: candidate, ...(ignoreId ? { NOT: { id: ignoreId } } : {}) },
      select: { id: true },
    })
    if (!clash) return candidate
    candidate = `${root}-${suffix++}`
  }
}

export function serializeWholesaleProduct(product) {
  return {
    id: product.id,
    categoryId: product.categoryId,
    catNo: product.catNo,
    name: product.name,
    strength: product.strength,
    vialSize: product.vialSize,
    price: toDollars(product.priceCents),
    priceCents: product.priceCents,
    sortOrder: product.sortOrder,
  }
}

export function serializeWholesaleCategory(category) {
  return {
    id: category.id,
    name: category.name,
    slug: category.slug,
    sortOrder: category.sortOrder,
    products: (category.products || []).map(serializeWholesaleProduct),
  }
}

/** Full catalogue grouped by category, ordered for display. */
export async function getWholesaleCatalog() {
  const categories = await prisma.wholesaleCategory.findMany({
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    include: {
      products: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
    },
  })
  return categories.map(serializeWholesaleCategory)
}

/* ------------------------------------------------------------------ */
/* Access password                                                     */
/* ------------------------------------------------------------------ */

async function readWholesaleSettings() {
  const row = await prisma.setting.findUnique({ where: { key: WHOLESALE_SETTINGS_KEY } })
  return row?.value && typeof row.value === 'object' ? row.value : {}
}

async function writeWholesaleSettings(next) {
  await prisma.setting.upsert({
    where: { key: WHOLESALE_SETTINGS_KEY },
    update: { value: next },
    create: { key: WHOLESALE_SETTINGS_KEY, value: next },
  })
}

/** Returns the stored hash, creating one from the default on first use. */
async function getAccessPasswordHash() {
  const settings = await readWholesaleSettings()
  if (settings.accessPasswordHash) return settings.accessPasswordHash

  const hash = await bcrypt.hash(DEFAULT_WHOLESALE_PASSWORD, 12)
  await writeWholesaleSettings({ ...settings, accessPasswordHash: hash })
  return hash
}

/** Verifies the visitor-entered access password. */
export async function verifyAccessPassword(password) {
  const value = String(password || '')
  if (!value) return false
  const hash = await getAccessPasswordHash()
  return bcrypt.compare(value, hash)
}

/** Admin: change the visitor access password. */
export async function changeAccessPassword({ currentPassword, newPassword }) {
  const next = String(newPassword || '').trim()
  if (next.length < 4) {
    throw badRequest('New password must be at least 4 characters.')
  }

  // Current password is optional (admin is already authenticated) but, when
  // provided, it must match so the UI "current password" field is meaningful.
  if (currentPassword !== undefined && currentPassword !== '') {
    const ok = await verifyAccessPassword(currentPassword)
    if (!ok) throw unauthorized('Current access password is incorrect.')
  }

  const settings = await readWholesaleSettings()
  const hash = await bcrypt.hash(next, 12)
  await writeWholesaleSettings({ ...settings, accessPasswordHash: hash })
  return { ok: true }
}

/* ------------------------------------------------------------------ */
/* Category CRUD                                                       */
/* ------------------------------------------------------------------ */

export async function createCategory({ name, sortOrder }) {
  const trimmed = String(name || '').trim()
  if (!trimmed) throw badRequest('Category name is required.')

  const count = await prisma.wholesaleCategory.count()
  const category = await prisma.wholesaleCategory.create({
    data: {
      name: trimmed,
      slug: await uniqueCategorySlug(trimmed),
      sortOrder: Number.isFinite(sortOrder) ? sortOrder : count,
    },
    include: { products: true },
  })
  return serializeWholesaleCategory(category)
}

export async function updateCategory(id, patch) {
  const existing = await prisma.wholesaleCategory.findUnique({ where: { id } })
  if (!existing) throw notFound('Category not found.')

  const data = {}
  if (patch.name !== undefined) {
    const trimmed = String(patch.name).trim()
    if (!trimmed) throw badRequest('Category name is required.')
    if (trimmed !== existing.name) {
      data.name = trimmed
      data.slug = await uniqueCategorySlug(trimmed, id)
    }
  }
  if (patch.sortOrder !== undefined) data.sortOrder = patch.sortOrder

  const category = await prisma.wholesaleCategory.update({
    where: { id },
    data,
    include: { products: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] } },
  })
  return serializeWholesaleCategory(category)
}

export async function deleteCategory(id) {
  const existing = await prisma.wholesaleCategory.findUnique({ where: { id } })
  if (!existing) throw notFound('Category not found.')
  await prisma.wholesaleCategory.delete({ where: { id } })
  return { ok: true }
}

/* ------------------------------------------------------------------ */
/* Product CRUD                                                        */
/* ------------------------------------------------------------------ */

function productWriteData(input) {
  const data = {}
  if (input.catNo !== undefined) data.catNo = String(input.catNo).trim()
  if (input.name !== undefined) data.name = String(input.name).trim()
  if (input.strength !== undefined) data.strength = String(input.strength).trim()
  if (input.vialSize !== undefined) data.vialSize = String(input.vialSize).trim()
  if (input.price !== undefined) data.priceCents = toCents(input.price)
  if (input.priceCents !== undefined) data.priceCents = Math.round(Number(input.priceCents) || 0)
  if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder
  return data
}

export async function createProduct(input) {
  const category = await prisma.wholesaleCategory.findUnique({
    where: { id: input.categoryId },
    select: { id: true },
  })
  if (!category) throw badRequest('Choose a valid category.')

  const count = await prisma.wholesaleProduct.count({ where: { categoryId: input.categoryId } })
  const product = await prisma.wholesaleProduct.create({
    data: {
      categoryId: input.categoryId,
      sortOrder: Number.isFinite(input.sortOrder) ? input.sortOrder : count,
      ...productWriteData(input),
    },
  })
  return serializeWholesaleProduct(product)
}

export async function updateProduct(id, patch) {
  const existing = await prisma.wholesaleProduct.findUnique({ where: { id } })
  if (!existing) throw notFound('Product not found.')

  const data = productWriteData(patch)
  if (patch.categoryId && patch.categoryId !== existing.categoryId) {
    const category = await prisma.wholesaleCategory.findUnique({
      where: { id: patch.categoryId },
      select: { id: true },
    })
    if (!category) throw badRequest('Choose a valid category.')
    data.categoryId = patch.categoryId
  }

  const product = await prisma.wholesaleProduct.update({ where: { id }, data })
  return serializeWholesaleProduct(product)
}

export async function deleteProduct(id) {
  const existing = await prisma.wholesaleProduct.findUnique({ where: { id } })
  if (!existing) throw notFound('Product not found.')
  await prisma.wholesaleProduct.delete({ where: { id } })
  return { ok: true }
}
