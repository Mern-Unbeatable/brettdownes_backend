import * as XLSX from 'xlsx'
import { prisma } from '../../lib/prisma.js'
import { badRequest } from '../../lib/http-error.js'

function normalizeName(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
}

function normalizeCode(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  return String(value || '')
    .trim()
    .toLowerCase()
}

function pickKey(keys, pattern) {
  return keys.find((key) => pattern.test(String(key || '').trim()))
}

function parseQuantity(raw, rowNumber) {
  const text = String(raw ?? '').trim()
  if (!text) {
    return { ok: false, error: `Row ${rowNumber}: Quantity is empty.` }
  }
  const quantity = Number.parseInt(text.replace(/[^\d-]/g, ''), 10)
  if (!Number.isFinite(quantity) || quantity < 0) {
    return {
      ok: false,
      error: `Row ${rowNumber}: Quantity must be a whole number of 0 or more.`,
    }
  }
  return { ok: true, quantity }
}

function readRows(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true, raw: false })
  const sheetName =
    workbook.SheetNames.find((name) => /goods|inventory|stock|qty|products/i.test(name)) ||
    workbook.SheetNames[0]
  if (!sheetName) throw badRequest('The spreadsheet has no sheets.')

  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
    defval: '',
    raw: false,
  })
  if (!rows.length) throw badRequest('The inventory sheet is empty.')

  const keys = Object.keys(rows[0] || {})
  const barcodeKey =
    pickKey(keys, /^(item\s*barcode|barcode|qr\s*code|qrcode|sku|cat\.?\s*no)$/i) ||
    pickKey(keys, /barcode|qr|sku|cat\.?\s*no/i)
  const productKey =
    pickKey(keys, /^(item\s*name|product|name)$/i) || pickKey(keys, /item\s*name|product|^name$/i)
  const qtyKey = pickKey(keys, /^(quantity|qty|stock)$/i) || pickKey(keys, /quantity|qty|stock/)

  if (!qtyKey) {
    throw badRequest(
      'Add a Quantity column. Expected headers: Item name | Item barcode | Quantity',
    )
  }
  if (!barcodeKey) {
    throw badRequest(
      'Add an Item barcode column. Expected headers: Item name | Item barcode | Quantity',
    )
  }

  const entries = []
  const rowErrors = []

  rows.forEach((row, index) => {
    const rowNumber = index + 2
    const barcode = normalizeCode(row[barcodeKey])
    const productName = productKey ? normalizeName(row[productKey]) : ''
    if (!barcode && !productName) return

    if (!barcode) {
      rowErrors.push(`Row ${rowNumber}: barcode is missing.`)
      return
    }

    const parsed = parseQuantity(row[qtyKey], rowNumber)
    if (!parsed.ok) {
      rowErrors.push(parsed.error)
      return
    }

    entries.push({
      row: rowNumber,
      barcode,
      productName,
      quantity: parsed.quantity,
    })
  })

  if (!entries.length) {
    const hint = rowErrors[0] ? ` ${rowErrors[0]}` : ''
    throw badRequest(
      `No valid inventory rows found.${hint} Use columns: Item name | Item barcode | Quantity.`,
    )
  }

  return { entries, rowErrors }
}

function inventoryCode(product) {
  return String(product.barcode || product.catNo || '').trim()
}

function formatItemName(product) {
  const parts = [product.name, product.strength, product.vialSize].filter(Boolean)
  return parts.join(' ').trim() || product.catNo || 'Item'
}

/**
 * Updates on-hand quantity only. Rows match Item barcode against barcode or cat. no.
 */
export async function importWholesaleSpreadsheet(buffer) {
  const { entries, rowErrors } = readRows(buffer)
  const products = await prisma.wholesaleProduct.findMany()

  const byCode = new Map()
  for (const product of products) {
    const barcode = normalizeCode(product.barcode)
    const catNo = normalizeCode(product.catNo)
    if (barcode) byCode.set(barcode, product)
    if (catNo && !byCode.has(catNo)) byCode.set(catNo, product)
  }

  const summary = {
    rows: entries.length,
    variantsUpdated: 0,
    notFound: [],
    rowErrors,
  }

  const seen = new Set()

  for (const entry of entries) {
    const product = byCode.get(normalizeCode(entry.barcode))
    if (!product) {
      summary.notFound.push({
        row: entry.row,
        barcode: entry.barcode,
        productName: entry.productName || null,
        message: `Barcode "${entry.barcode}" not found — quantity was not updated.`,
      })
      continue
    }
    if (seen.has(product.id)) continue
    seen.add(product.id)

    await prisma.wholesaleProduct.update({
      where: { id: product.id },
      data: {
        stock: entry.quantity,
        inStock: entry.quantity > 0,
      },
    })
    summary.variantsUpdated += 1
  }

  return { summary }
}

/** Same Excel layout as the main shop: Item name | Item barcode | Quantity. */
export async function buildWholesaleInventoryTemplate() {
  const products = await prisma.wholesaleProduct.findMany({
    include: { category: { select: { name: true, sortOrder: true } } },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  })

  const inventoryRows = [
    ['Item name', 'Item barcode', 'Quantity'],
    ...products.map((product) => [
      formatItemName(product),
      inventoryCode(product),
      product.stock,
    ]),
  ]

  const instructionRows = [
    ['Peptide Ops — other store inventory update'],
    [''],
    ['Use this file to update stock only. Same columns as the main shop Products spreadsheet.'],
    [''],
    ['Columns'],
    ['Item name', 'Shown for reference. Changing it does not rename the live product.'],
    [
      'Item barcode',
      'Required. Matches the product barcode, or cat. no if barcode is blank. Do not change this value.',
    ],
    ['Quantity', 'Edit this. Enter the new on-hand count (0 or more).'],
    [''],
    ['Rules'],
    ['1. Do not add extra header rows above Item name / Item barcode / Quantity.'],
    ['2. Leave Item barcode exactly as exported. That is how the site finds the product.'],
    ['3. Export inventory from Admin → Secret page, edit Quantity, then Import Excel.'],
    ['4. Unknown barcodes are listed in the upload result. Prices and names stay the same.'],
    ['5. Quantity 0 marks the item out of stock on /other. Customers cannot order more than this count.'],
  ]

  const workbook = XLSX.utils.book_new()
  const inventory = XLSX.utils.aoa_to_sheet(inventoryRows)
  inventory['!cols'] = [{ wch: 36 }, { wch: 18 }, { wch: 12 }]
  inventory['!autofilter'] = { ref: `A1:C${Math.max(inventoryRows.length, 1)}` }
  inventory['!freeze'] = { xSplit: 0, ySplit: 1 }

  const instructions = XLSX.utils.aoa_to_sheet(instructionRows)
  instructions['!cols'] = [{ wch: 18 }, { wch: 78 }]

  XLSX.utils.book_append_sheet(workbook, inventory, 'Goods')
  XLSX.utils.book_append_sheet(workbook, instructions, 'Instructions')

  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })
}
