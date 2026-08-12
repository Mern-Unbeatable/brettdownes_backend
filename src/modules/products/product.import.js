import * as XLSX from 'xlsx'
import { prisma } from '../../lib/prisma.js'
import { badRequest } from '../../lib/http-error.js'
import { serializeProduct, slugify, uniqueSku, uniqueSlug } from './product.controller.js'

const DOSE_RE = /^(.*?)\s+(\d+(?:\.\d+)?\s*(?:mg|ml|mcg|iu|g))\s*$/i

function normalizeDose(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/([a-zA-Z]+)$/, (unit) => unit.toLowerCase())
}

function normalizeName(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
}

/** Split "BPC-157 5mg" → product + dose. Names without a dose stay whole. */
export function parseItemName(raw) {
  const name = normalizeName(raw)
  if (!name) return null

  const match = name.match(DOSE_RE)
  if (match) {
    return {
      productName: normalizeName(match[1]),
      dose: normalizeDose(match[2]),
    }
  }

  return { productName: name, dose: 'Standard' }
}

function readRows(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' })
  const sheetName = workbook.SheetNames[0]
  if (!sheetName) throw badRequest('The spreadsheet has no sheets.')

  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' })
  if (!rows.length) throw badRequest('The spreadsheet is empty.')

  const sample = rows[0]
  const keys = Object.keys(sample)
  const nameKey =
    keys.find((key) => /item\s*name|product|name|товар/i.test(key)) ||
    keys.find((key) => /name/i.test(key))
  const qtyKey =
    keys.find((key) => /quantity|qty|stock|кол/i.test(key)) ||
    keys.find((key) => /count|amount/i.test(key))
  const barcodeKey = keys.find((key) => /barcode|sku|code/i.test(key))

  if (!nameKey) {
    throw badRequest('Could not find an "Item name" column in the spreadsheet.')
  }
  if (!qtyKey) {
    throw badRequest('Could not find a "Quantity" column in the spreadsheet.')
  }

  return rows
    .map((row, index) => {
      const parsed = parseItemName(row[nameKey])
      if (!parsed) return null
      const quantity = Number.parseInt(String(row[qtyKey]).replace(/[^\d-]/g, ''), 10)
      if (!Number.isFinite(quantity) || quantity < 0) {
        throw badRequest(`Row ${index + 2}: quantity must be a whole number ≥ 0.`)
      }
      return {
        ...parsed,
        quantity,
        barcode: barcodeKey ? String(row[barcodeKey] || '').trim() : '',
        rawName: normalizeName(row[nameKey]),
      }
    })
    .filter(Boolean)
}

/**
 * Upserts products/variants from a Main Store style spreadsheet.
 * Matching is by product name + dose (case-insensitive). Existing prices are
 * preserved; brand-new variants start at $0 so an admin can price them later.
 */
export async function importSpreadsheet(buffer) {
  const entries = readRows(buffer)

  const grouped = new Map()
  for (const entry of entries) {
    const key = entry.productName.toLowerCase()
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key).push(entry)
  }

  const summary = {
    productsCreated: 0,
    productsUpdated: 0,
    variantsCreated: 0,
    variantsUpdated: 0,
    rows: entries.length,
  }

  const touched = []

  for (const [, items] of grouped) {
    const productName = items[0].productName

    let product = await prisma.product.findFirst({
      where: { name: { equals: productName, mode: 'insensitive' } },
      include: { variants: true },
    })

    if (!product) {
      const createVariants = []
      for (const [index, item] of items.entries()) {
        createVariants.push({
          dose: item.dose,
          priceCents: 0,
          sku: item.barcode || (await uniqueSku(`${slugify(productName)}-${item.dose}`)),
          stock: item.quantity,
          sortOrder: index,
          weightOz: 2,
          lengthIn: 6,
          widthIn: 4,
          heightIn: 2,
          isActive: true,
        })
      }

      product = await prisma.product.create({
        data: {
          name: productName,
          slug: await uniqueSlug(productName),
          category: 'Peptides',
          summary: '',
          description: '',
          isActive: true,
          variants: { create: createVariants },
        },
        include: { variants: { orderBy: { sortOrder: 'asc' } } },
      })

      summary.productsCreated += 1
      summary.variantsCreated += createVariants.length
      touched.push(product)
      continue
    }

    summary.productsUpdated += 1

    for (const [index, item] of items.entries()) {
      const existing = product.variants.find(
        (variant) => normalizeDose(variant.dose).toLowerCase() === item.dose.toLowerCase(),
      )

      if (existing) {
        await prisma.variant.update({
          where: { id: existing.id },
          data: {
            stock: item.quantity,
            ...(item.barcode && !existing.sku ? { sku: item.barcode } : {}),
          },
        })
        summary.variantsUpdated += 1
      } else {
        await prisma.variant.create({
          data: {
            productId: product.id,
            dose: item.dose,
            priceCents: 0,
            sku: item.barcode || (await uniqueSku(`${slugify(productName)}-${item.dose}`)),
            stock: item.quantity,
            sortOrder: product.variants.length + index,
            weightOz: 2,
            lengthIn: 6,
            widthIn: 4,
            heightIn: 2,
            isActive: true,
          },
        })
        summary.variantsCreated += 1
      }
    }

    const refreshed = await prisma.product.findUnique({
      where: { id: product.id },
      include: { variants: { orderBy: [{ sortOrder: 'asc' }, { priceCents: 'asc' }] } },
    })
    touched.push(refreshed)
  }

  return {
    summary,
    products: touched.map(serializeProduct),
  }
}
