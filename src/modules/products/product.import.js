import * as XLSX from 'xlsx'
import { prisma } from '../../lib/prisma.js'
import { badRequest } from '../../lib/http-error.js'

function normalizeName(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
}

function normalizeBarcode(value) {
  // Excel may send barcodes as numbers; keep full string without scientific notation.
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
    pickKey(keys, /^(item\s*barcode|barcode|qr\s*code|qrcode|sku)$/i) ||
    pickKey(keys, /barcode|qr|sku/i)
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
    const barcode = normalizeBarcode(row[barcodeKey])
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

/**
 * Updates on-hand quantity only. Rows match by barcode (case-insensitive).
 * Unknown barcodes and bad rows are reported — they do not block other updates.
 */
export async function importSpreadsheet(buffer) {
  const { entries, rowErrors } = readRows(buffer)
  const variants = await prisma.variant.findMany({
    include: { product: { select: { id: true, name: true } } },
  })

  const byBarcode = new Map(
    variants.map((variant) => [normalizeBarcode(variant.barcode), variant]),
  )

  const summary = {
    rows: entries.length,
    variantsUpdated: 0,
    notFound: [],
    rowErrors,
  }

  const seen = new Set()

  for (const entry of entries) {
    const variant = byBarcode.get(normalizeBarcode(entry.barcode))

    if (!variant) {
      summary.notFound.push({
        row: entry.row,
        barcode: entry.barcode,
        productName: entry.productName || null,
        message: `Barcode "${entry.barcode}" not found — quantity was not updated.`,
      })
      continue
    }
    if (seen.has(variant.id)) continue
    seen.add(variant.id)

    await prisma.variant.update({
      where: { id: variant.id },
      data: { stock: entry.quantity },
    })
    summary.variantsUpdated += 1
  }

  return { summary }
}

function formatItemName(product, variant) {
  const dose = String(variant.dose || '').trim()
  const name = String(product.name || '').trim()
  if (!dose) return name
  if (name.toLowerCase().includes(dose.toLowerCase())) return name
  return `${name} ${dose}`
}

/** Live Excel the admin can fill in — barcode locked, Quantity is the editable column. */
export async function buildInventoryTemplate() {
  const products = await prisma.product.findMany({
    include: { variants: { orderBy: [{ sortOrder: 'asc' }, { dose: 'asc' }] } },
    orderBy: [{ name: 'asc' }],
  })

  const inventoryRows = [
    ['Item name', 'Item barcode', 'Quantity'],
    ...products.flatMap((product) =>
      product.variants.map((variant) => [
        formatItemName(product, variant),
        variant.barcode,
        variant.stock,
      ]),
    ),
  ]

  const instructionRows = [
    ['Peptide Ops — inventory update'],
    [''],
    ['Use this file to update stock only. One upload refreshes every matching variant.'],
    [''],
    ['Columns'],
    ['Item name', 'Shown for reference (product + dose). Changing it does not rename the live product.'],
    ['Item barcode', 'Required. Matches the variant (case-insensitive). Do not change this value.'],
    ['Quantity', 'Edit this. Enter the new on-hand count (0 or more).'],
    [''],
    ['Rules'],
    ['1. Keep one row per dose. BPC-157 5mg and BPC-157 10mg are separate rows.'],
    ['2. Do not add extra header rows above Item name / Item barcode / Quantity.'],
    ['3. Leave Item barcode exactly as exported. That is how the site finds the product.'],
    ['4. Upload the saved .xlsx from Admin → Products → Import Excel.'],
    ['5. Unknown barcodes are listed in the upload result. Prices, photos, and descriptions stay the same.'],
    ['6. Do not use the old SKU template (PO-BPC-5). The site matches Item barcode only (bpc5, mot10, etc.).'],
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
