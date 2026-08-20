import * as XLSX from 'xlsx'
import { prisma } from '../../lib/prisma.js'
import { badRequest } from '../../lib/http-error.js'

function normalizeName(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
}

function pickKey(keys, pattern) {
  return keys.find((key) => pattern.test(key))
}

function parseQuantity(raw, rowNumber) {
  const quantity = Number.parseInt(String(raw ?? '').replace(/[^\d-]/g, ''), 10)
  if (!Number.isFinite(quantity) || quantity < 0) {
    throw badRequest(`Row ${rowNumber}: Quantity must be a whole number of 0 or more.`)
  }
  return quantity
}

function readRows(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' })
  const sheetName =
    workbook.SheetNames.find((name) => /goods|inventory|stock|qty|products/i.test(name)) ||
    workbook.SheetNames[0]
  if (!sheetName) throw badRequest('The spreadsheet has no sheets.')

  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' })
  if (!rows.length) throw badRequest('The inventory sheet is empty.')

  const keys = Object.keys(rows[0] || {})
  const barcodeKey =
    pickKey(keys, /^(item\s*barcode|barcode|qr\s*code|qrcode)$/i) ||
    pickKey(keys, /barcode|qr/i)
  const productKey =
    pickKey(keys, /^(item\s*name|product|name)$/i) || pickKey(keys, /item\s*name|product|^name$/i)
  const qtyKey = pickKey(keys, /^(quantity|qty|stock)$/i) || pickKey(keys, /quantity|qty|stock/)

  if (!qtyKey) throw badRequest('Add a Quantity column (Quantity / Qty / Stock).')
  if (!barcodeKey) {
    throw badRequest('Add an Item barcode column. Every variant row must include a barcode.')
  }

  return rows
    .map((row, index) => {
      const barcode = String(row[barcodeKey] || '').trim()
      const productName = productKey ? normalizeName(row[productKey]) : ''
      if (!barcode && !productName) return null
      if (!barcode) {
        throw badRequest(`Row ${index + 2}: every variant needs a barcode.`)
      }
      return {
        row: index + 2,
        barcode,
        productName,
        quantity: parseQuantity(row[qtyKey], index + 2),
      }
    })
    .filter(Boolean)
}

/**
 * Updates on-hand quantity only. Rows match by barcode. Unknown barcodes are skipped.
 * Prices, photos, and names are never changed.
 */
export async function importSpreadsheet(buffer) {
  const entries = readRows(buffer)
  const variants = await prisma.variant.findMany({
    include: { product: { select: { id: true, name: true } } },
  })

  const byBarcode = new Map(
    variants.map((variant) => [variant.barcode.trim().toLowerCase(), variant]),
  )

  const summary = {
    rows: entries.length,
    variantsUpdated: 0,
    notFound: [],
  }

  const seen = new Set()

  for (const entry of entries) {
    const variant = byBarcode.get(entry.barcode.toLowerCase())

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
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
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
    ['Item barcode', 'Required. Matches the variant. Do not change this value.'],
    ['Quantity', 'Edit this. Enter the new on-hand count (0 or more).'],
    [''],
    ['Rules'],
    ['1. Keep one row per dose. BPC-157 5mg and BPC-157 10mg are separate rows.'],
    ['2. Do not add extra header rows above Item name / Item barcode / Quantity.'],
    ['3. Leave Item barcode exactly as exported. That is how the site finds the product.'],
    ['4. Upload the saved .xlsx from Admin → Products → Import Excel.'],
    ['5. If a barcode is not on the site yet, that row is skipped and listed in the upload result.'],
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
