import bcrypt from 'bcryptjs'
import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound, unauthorized } from '../../lib/http-error.js'
import { toCents, toDollars } from '../../lib/money.js'
import { buildParcel, createShipmentWithRates, refreshRates } from '../../lib/easypost.js'
import { getSettings } from '../settings/settings.service.js'
import { calculateCouponDiscount } from '../orders/discount.service.js'
import { inferCarrier, trackingUrlFor } from '../orders/new-orders.js'

const WHOLESALE_SETTINGS_KEY = 'wholesale'

export const WHOLESALE_ORDER_INCLUDE = {
  items: true,
  events: { orderBy: { createdAt: 'desc' } },
}
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
  const stock = Math.max(0, Number(product.stock) || 0)
  return {
    id: product.id,
    categoryId: product.categoryId,
    catNo: product.catNo,
    barcode: product.barcode || '',
    name: product.name,
    strength: product.strength,
    vialSize: product.vialSize,
    price: toDollars(product.priceCents),
    priceCents: product.priceCents,
    stock,
    inStock: stock > 0,
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
  if (input.barcode !== undefined) data.barcode = String(input.barcode || '').trim()
  if (input.stock !== undefined) {
    data.stock = Math.max(0, Math.trunc(Number(input.stock) || 0))
    data.inStock = data.stock > 0
  } else if (input.inStock !== undefined) {
    data.inStock = Boolean(input.inStock)
    if (!data.inStock) data.stock = 0
  }
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

/* ------------------------------------------------------------------ */
/* Storefront config (note banner, Telegram link)                       */
/* ------------------------------------------------------------------ */

const DEFAULT_NOTE =
  "These are more specialized items, so they're not always in stock. If something you need is out of stock, contact us and we'll add it to our next order."

/** Public config shown on the /other storefront. Shipping uses live carrier rates at checkout. */
export async function getWholesaleConfig() {
  const settings = await readWholesaleSettings()
  return {
    note: typeof settings.note === 'string' ? settings.note : DEFAULT_NOTE,
    telegramUrl: typeof settings.telegramUrl === 'string' ? settings.telegramUrl : '',
  }
}

/** Admin: update the storefront config. */
export async function updateWholesaleConfig(patch) {
  const settings = await readWholesaleSettings()
  const next = { ...settings }
  if (patch.note !== undefined) next.note = String(patch.note || '').slice(0, 2000)
  if (patch.telegramUrl !== undefined) next.telegramUrl = String(patch.telegramUrl || '').trim().slice(0, 400)
  await writeWholesaleSettings(next)
  return getWholesaleConfig()
}

/* ------------------------------------------------------------------ */
/* Guest orders + checkout                                             */
/* ------------------------------------------------------------------ */

export function serializeWholesaleOrder(order) {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    paymentStatus: order.paymentStatus,
    subtotalCents: order.subtotalCents,
    discountCents: order.discountCents,
    couponCode: order.couponCode,
    shippingCents: order.shippingCents,
    totalCents: order.totalCents,
    currency: order.currency,
    shippingLabel: order.shippingLabel,
    contactName: order.contactName,
    contactEmail: order.contactEmail,
    contactPhone: order.contactPhone,
    addressLine1: order.addressLine1,
    addressLine2: order.addressLine2,
    city: order.city,
    state: order.state,
    zip: order.zip,
    country: order.country,
    notes: order.notes,
    trackingCode: order.trackingCode,
    trackingUrl: order.trackingUrl,
    carrier: order.carrier,
    shippedAt: order.shippedAt,
    paidAt: order.paidAt,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    items: (order.items || []).map((item) => ({
      id: item.id,
      catNo: item.catNo,
      productName: item.productName,
      strength: item.strength,
      vialSize: item.vialSize,
      unitPriceCents: item.unitPriceCents,
      price: toDollars(item.unitPriceCents),
      qty: item.qty,
    })),
    events: (order.events || []).map((event) => ({
      id: event.id,
      type: event.type,
      message: event.message,
      createdAt: event.createdAt,
    })),
  }
}

/** ORD-YYMMDD-XXXX — same format as the main shop (separate table, so numbers never clash). */
async function nextWholesaleOrderNumber() {
  const stamp = new Date().toISOString().slice(2, 10).replace(/-/g, '')
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const suffix = Math.floor(1000 + Math.random() * 9000)
    const candidate = `ORD-${stamp}-${suffix}`
    const clash = await prisma.wholesaleOrder.findUnique({
      where: { orderNumber: candidate },
      select: { id: true },
    })
    if (!clash) return candidate
  }
  return `ORD-${stamp}-${Date.now().toString().slice(-6)}`
}

/**
 * Resolves client-supplied order lines against the catalogue. Prices and the
 * item snapshot always come from the DB so the client cannot influence what is
 * charged or shipped.
 */
async function resolveWholesaleItems(lines) {
  if (!Array.isArray(lines) || !lines.length) throw badRequest('Your order is empty.')

  const ids = [...new Set(lines.map((line) => String(line.id)))]
  const products = await prisma.wholesaleProduct.findMany({ where: { id: { in: ids } } })
  const byId = new Map(products.map((product) => [product.id, product]))

  const items = []
  for (const line of lines) {
    const product = byId.get(String(line.id))
    if (!product) throw badRequest('One of the items is no longer available.')
    const onHand = Math.max(0, Number(product.stock) || 0)
    const label = product.name || product.catNo || 'Item'
    if (onHand < 1) {
      throw badRequest(`${label} is out of stock.`)
    }
    const qty = Math.max(1, Math.trunc(Number(line.qty) || 1))
    if (qty > onHand) {
      throw badRequest(
        `${label} only has ${onHand} in stock. Remove extra quantity and try again.`,
      )
    }
    items.push({
      // productId/category let the shared coupon calculator run; private-store
      // ids never match main-shop product coupons, so only "all products"
      // coupons apply here.
      productId: product.id,
      category: 'Other',
      catNo: product.catNo,
      productName: product.name || product.catNo || 'Item',
      strength: product.strength,
      vialSize: product.vialSize,
      unitPriceCents: product.priceCents,
      qty,
    })
  }

  const subtotalCents = items.reduce((sum, item) => sum + item.unitPriceCents * item.qty, 0)
  return { items, subtotalCents }
}

/** Validates a coupon against a private-store cart (guest, no account). */
export async function validateWholesaleCoupon({ items: lines, code }) {
  const { items } = await resolveWholesaleItems(lines)
  return calculateCouponDiscount(items, code)
}

/**
 * Live carrier quotes for the private store — the exact same EasyPost flow as
 * the main shop, so the customer picks a real USPS/FedEx/UPS rate. Guest access
 * (no account needed).
 */
export async function quoteWholesaleRates({ items: lines, address }) {
  const { items, subtotalCents } = await resolveWholesaleItems(lines)
  const settings = await getSettings()
  const parcel = buildParcel(items)

  const { shipmentId, rates } = await createShipmentWithRates({
    toAddress: {
      name: address.name || address.email || 'Customer',
      street1: address.line1,
      street2: address.line2 || undefined,
      city: address.city,
      state: address.state,
      zip: address.zip,
      country: address.country,
      phone: address.phone || undefined,
      email: address.email || undefined,
    },
    fromAddress: settings.shipFrom,
    parcel,
  })

  const threshold = settings.freeShippingThresholdCents
  const qualifiesFree = threshold > 0 && subtotalCents >= threshold

  return {
    shipmentId,
    parcel,
    freeShipping: qualifiesFree,
    rates: rates.map((rate) => ({
      ...rate,
      // Fold handling into the shown price so the charged total always matches.
      amountCents: qualifiesFree ? 0 : rate.amountCents + settings.handlingFeeCents,
    })),
  }
}

/**
 * Builds a pending order from client input. Prices come from the DB and the
 * shipping cost is re-read from EasyPost (never trusted from the client) so the
 * charged total is authoritative.
 */
export async function createPendingWholesaleOrder(input) {
  const { items, subtotalCents } = await resolveWholesaleItems(input.items)
  const settings = await getSettings()

  // Re-validate the coupon server-side so the client can't dictate the discount.
  const coupon = input.couponCode
    ? await calculateCouponDiscount(items, input.couponCode)
    : null
  const discountCents = Math.min(subtotalCents, coupon?.discountCents || 0)
  const merchandiseCents = Math.max(0, subtotalCents - discountCents)

  const shipCountry = String(input.address?.country || 'US').trim().toUpperCase()
  const { rates } = await refreshRates(input.shipmentId, {
    international: shipCountry !== 'US',
  })
  const rate = rates.find((entry) => entry.id === input.rateId)
  if (!rate) {
    throw badRequest('That shipping rate has expired. Please recalculate shipping and try again.')
  }

  const threshold = settings.freeShippingThresholdCents
  const qualifiesFree = threshold > 0 && merchandiseCents >= threshold
  const shippingCents = qualifiesFree ? 0 : rate.amountCents + settings.handlingFeeCents
  const shippingLabel = [rate.carrier, rate.service].filter(Boolean).join(' ') || 'Shipping'
  const totalCents = merchandiseCents + shippingCents

  const orderNumber = await nextWholesaleOrderNumber()
  const order = await prisma.wholesaleOrder.create({
    data: {
      orderNumber,
      status: 'PENDING',
      paymentStatus: 'UNPAID',
      subtotalCents,
      discountCents,
      couponCode: coupon?.code || null,
      shippingCents,
      totalCents,
      shippingLabel,
      carrier: rate.carrier || null,
      contactName: input.contact.name,
      contactEmail: input.contact.email,
      contactPhone: input.contact.phone,
      addressLine1: input.address.line1,
      addressLine2: input.address.line2 || null,
      city: input.address.city,
      state: input.address.state,
      zip: input.address.zip,
      country: input.address.country || 'US',
      notes: input.notes || null,
      items: {
        create: items.map((item) => ({
          productId: item.productId,
          catNo: item.catNo,
          productName: item.productName,
          strength: item.strength,
          vialSize: item.vialSize,
          unitPriceCents: item.unitPriceCents,
          qty: item.qty,
        })),
      },
    },
    include: { items: true },
  })

  if (coupon?.couponId) {
    await prisma.coupon.update({
      where: { id: coupon.couponId },
      data: { usageCount: { increment: 1 } },
    }).catch(() => {})
  }

  return order
}

export async function attachWholesaleSession(orderId, sessionId) {
  await prisma.wholesaleOrder.update({
    where: { id: orderId },
    data: { stripeSessionId: sessionId },
  })
}

const DEDUCT_EVENT = 'INVENTORY_DEDUCT'
const RESTORE_EVENT = 'INVENTORY_RESTORE'

async function deductWholesaleStock(order) {
  if (!order?.id || !order.items?.length) return
  const already = await prisma.wholesaleOrderEvent.findFirst({
    where: { orderId: order.id, type: DEDUCT_EVENT },
    select: { id: true },
  })
  if (already) return

  const lines = order.items.filter((item) => item.productId && item.qty > 0)
  if (!lines.length) {
    await prisma.wholesaleOrderEvent.create({
      data: {
        orderId: order.id,
        type: DEDUCT_EVENT,
        message: 'Inventory not reduced (no catalogue product ids on this order).',
      },
    })
    return
  }

  await prisma.$transaction(async (tx) => {
    for (const item of lines) {
      const updated = await tx.wholesaleProduct.updateMany({
        where: { id: item.productId, stock: { gte: item.qty } },
        data: { stock: { decrement: item.qty } },
      })
      if (updated.count === 0) {
        await tx.$executeRaw`
          UPDATE "WholesaleProduct"
          SET stock = GREATEST(0, stock - ${item.qty})
          WHERE id = ${item.productId}
        `
      }
      await tx.$executeRaw`
        UPDATE "WholesaleProduct"
        SET "inStock" = (stock > 0)
        WHERE id = ${item.productId}
      `
    }

    await tx.wholesaleOrderEvent.create({
      data: {
        orderId: order.id,
        type: DEDUCT_EVENT,
        message: `Inventory reduced for ${lines.length} line${lines.length === 1 ? '' : 's'}.`,
      },
    })
  })
}

async function restoreWholesaleStock(order) {
  if (!order?.id || !order.items?.length) return
  const deducted = await prisma.wholesaleOrderEvent.findFirst({
    where: { orderId: order.id, type: DEDUCT_EVENT },
    select: { id: true },
  })
  if (!deducted) return
  const already = await prisma.wholesaleOrderEvent.findFirst({
    where: { orderId: order.id, type: RESTORE_EVENT },
    select: { id: true },
  })
  if (already) return

  const lines = order.items.filter((item) => item.productId && item.qty > 0)
  if (!lines.length) return

  await prisma.$transaction(async (tx) => {
    for (const item of lines) {
      await tx.wholesaleProduct.updateMany({
        where: { id: item.productId },
        data: { stock: { increment: item.qty }, inStock: true },
      })
    }
    await tx.wholesaleOrderEvent.create({
      data: {
        orderId: order.id,
        type: RESTORE_EVENT,
        message: `Inventory restored for ${lines.length} line${lines.length === 1 ? '' : 's'}.`,
      },
    })
  })
}

/** Marks a wholesale order paid exactly once. Returns the order or null if already paid. */
export async function markWholesaleOrderPaid(orderId) {
  const result = await prisma.wholesaleOrder.updateMany({
    where: { id: orderId, paymentStatus: { not: 'PAID' } },
    data: { paymentStatus: 'PAID', status: 'PROCESSING', paidAt: new Date() },
  })
  if (result.count === 0) return null
  const paid = await prisma.wholesaleOrder.findUnique({
    where: { id: orderId },
    include: WHOLESALE_ORDER_INCLUDE,
  })
  if (paid) {
    await prisma.wholesaleOrderEvent.create({
      data: {
        orderId: paid.id,
        type: 'PAYMENT',
        message: 'Stripe payment received. Order marked processing.',
      },
    })
    await deductWholesaleStock(paid)
  }
  return prisma.wholesaleOrder.findUnique({
    where: { id: orderId },
    include: WHOLESALE_ORDER_INCLUDE,
  })
}

export async function getWholesaleOrder(id) {
  const order = await prisma.wholesaleOrder.findUnique({
    where: { id },
    include: WHOLESALE_ORDER_INCLUDE,
  })
  if (!order) throw notFound('Order not found.')
  return order
}

/** Backfill a timeline row when tracking was saved before events existed. */
export async function ensureWholesaleTrackingTimelineSeed(order) {
  if (!order?.trackingCode) return
  const count = await prisma.wholesaleOrderEvent.count({ where: { orderId: order.id } })
  if (count > 0) return
  const carrier = inferCarrier(order.trackingCode, order.carrier || order.shippingLabel) || 'USPS'
  await prisma.wholesaleOrderEvent.create({
    data: {
      orderId: order.id,
      type: 'TRACKING',
      message: `${carrier} tracking ${order.trackingCode} added. Order marked shipped.`,
      ...(order.shippedAt ? { createdAt: order.shippedAt } : {}),
    },
  })
}

/** Pulls USPS/UPS scans onto the other-store order timeline (same as main shop poller). */
export async function refreshWholesaleOrderTracking(order) {
  if (!order?.trackingCode) return order
  if (['DELIVERED', 'CANCELLED', 'REFUNDED'].includes(order.status)) return order
  await ensureWholesaleTrackingTimelineSeed(order)
  const { fetchCarrierTracking } = await import('../../lib/easypost.js')
  const { applyWholesaleCarrierScans } = await import('../orders/tracking.service.js')
  try {
    const snapshot = await fetchCarrierTracking({
      trackingCode: order.trackingCode,
      carrier: `${order.carrier || ''} ${order.shippingLabel || ''}`,
    })
    await applyWholesaleCarrierScans(order, snapshot)
  } catch {
    // Missing tracking API key or carrier hiccup — still return order with seed event.
  }
  return getWholesaleOrder(order.id)
}

export async function listWholesaleOrders({
  status,
  paymentStatus,
  search,
  page = 1,
  perPage = 20,
} = {}) {
  const where = {
    ...(status ? { status } : {}),
    ...(paymentStatus ? { paymentStatus } : {}),
    ...(search
      ? {
          OR: [
            { orderNumber: { contains: search, mode: 'insensitive' } },
            { contactName: { contains: search, mode: 'insensitive' } },
            { contactEmail: { contains: search, mode: 'insensitive' } },
            { trackingCode: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}),
  }

  const [total, orders, allCount, awaiting, paidAgg] = await Promise.all([
    prisma.wholesaleOrder.count({ where }),
    prisma.wholesaleOrder.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    prisma.wholesaleOrder.count(),
    prisma.wholesaleOrder.count({ where: { status: { in: ['PENDING', 'PROCESSING'] } } }),
    prisma.wholesaleOrder.aggregate({
      where: { paymentStatus: 'PAID' },
      _sum: { totalCents: true },
    }),
  ])

  return {
    orders: orders.map(serializeWholesaleOrder),
    total,
    page,
    perPage,
    pages: Math.max(1, Math.ceil(total / perPage)),
    stats: {
      total: allCount,
      awaiting,
      revenueCents: paidAgg._sum.totalCents || 0,
    },
  }
}

export async function updateWholesaleOrderStatus(id, status) {
  const existing = await prisma.wholesaleOrder.findUnique({
    where: { id },
    include: WHOLESALE_ORDER_INCLUDE,
  })
  if (!existing) throw notFound('Order not found.')
  const order = await prisma.wholesaleOrder.update({
    where: { id },
    data: {
      status,
      ...(status === 'SHIPPED' && !existing.shippedAt ? { shippedAt: new Date() } : {}),
      ...(status === 'PAID' ? {} : {}),
    },
    include: WHOLESALE_ORDER_INCLUDE,
  })
  if (status === 'CANCELLED' || status === 'REFUNDED') {
    await restoreWholesaleStock(order)
    return getWholesaleOrder(id)
  }
  return order
}

export async function updateWholesaleOrderPayment(id, paymentStatus) {
  const existing = await prisma.wholesaleOrder.findUnique({
    where: { id },
    include: WHOLESALE_ORDER_INCLUDE,
  })
  if (!existing) throw notFound('Order not found.')
  const order = await prisma.wholesaleOrder.update({
    where: { id },
    data: {
      paymentStatus,
      ...(paymentStatus === 'PAID' && !existing.paidAt ? { paidAt: new Date() } : {}),
      ...(paymentStatus === 'PAID' && existing.status === 'PENDING' ? { status: 'PROCESSING' } : {}),
    },
    include: WHOLESALE_ORDER_INCLUDE,
  })
  if (paymentStatus === 'PAID' && existing.paymentStatus !== 'PAID') {
    await deductWholesaleStock(order)
    return getWholesaleOrder(id)
  }
  if (paymentStatus === 'REFUNDED') {
    await restoreWholesaleStock(order)
    return getWholesaleOrder(id)
  }
  return order
}

/** Saves a tracking number and returns the order so the caller can email the customer. */
export async function setWholesaleOrderTracking(id, { trackingCode, carrier, trackingUrl }) {
  const existing = await prisma.wholesaleOrder.findUnique({ where: { id } })
  if (!existing) throw notFound('Order not found.')
  const code = String(trackingCode || '').trim()
  if (!code) throw badRequest('Paste a tracking number.')
  const resolvedCarrier = inferCarrier(code, carrier || existing.carrier || existing.shippingLabel)
  const resolvedUrl =
    (trackingUrl && String(trackingUrl).trim()) ||
    trackingUrlFor(resolvedCarrier, code) ||
    existing.trackingUrl
  const label = resolvedCarrier || 'Carrier'
  const order = await prisma.wholesaleOrder.update({
    where: { id },
    data: {
      trackingCode: code,
      carrier: resolvedCarrier || existing.carrier,
      trackingUrl: resolvedUrl,
      status: 'SHIPPED',
      shippedAt: existing.shippedAt || new Date(),
      events: {
        create: {
          type: 'TRACKING',
          message: `${label} tracking ${code} added. Order marked shipped.`,
        },
      },
    },
    include: WHOLESALE_ORDER_INCLUDE,
  })
  return order
}

export async function deleteWholesaleOrder(id) {
  const existing = await prisma.wholesaleOrder.findUnique({
    where: { id },
    include: WHOLESALE_ORDER_INCLUDE,
  })
  if (!existing) throw notFound('Order not found.')
  await restoreWholesaleStock(existing)
  await prisma.wholesaleOrder.delete({ where: { id } })
  return { ok: true }
}
