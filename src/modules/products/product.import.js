import * as XLSX from 'xlsx'
import { prisma } from '../../lib/prisma.js'
import { badRequest } from '../../lib/http-error.js'

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
    workbook.SheetNames.find((name) => /inventory|stock|qty|products/i.test(name)) ||
    workbook.SheetNames[0]
  if (!sheetName) throw badRequest('The spreadsheet has no sheets.')

  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' })
  if (!rows.length) throw badRequest('The Inventory sheet is empty.')

  const keys = Object.keys(rows[0] || {})
  const skuKey = pickKey(keys, /^(sku|barcode|variant\s*sku|item\s*code)$/i) || pickKey(keys, /sku|barcode/i)
  const productKey =
    pickKey(keys, /^(product|item\s*name|name)$/i) || pickKey(keys, /product|item\s*name|^name$/i)
  const doseKey = pickKey(keys, /^(dose|strength|size)$/i) || pickKey(keys, /dose|strength/)
  const qtyKey = pickKey(keys, /^(quantity|qty|stock)$/i) || pickKey(keys, /quantity|qty|stock/)

  if (!qtyKey) throw badRequest('Add a Quantity column (Quantity / Qty / Stock).')
  if (!skuKey) throw badRequest('Add a SKU column. Every variant row must include a SKU.')

  return rows
    .map((row, index) => {
      const sku = String(row[skuKey] || '').trim()
      const productName = productKey ? normalizeName(row[productKey]) : ''
      const dose = doseKey ? normalizeDose(row[doseKey]) : ''
      if (!sku && !productName && !dose) return null
      if (!sku) {
        throw badRequest(`Row ${index + 2}: every variant needs a SKU.`)
      }
      return {
        sku,
        productName,
        dose,
        quantity: parseQuantity(row[qtyKey], index + 2),
      }
    })
    .filter(Boolean)
}

/**
 * Updates on-hand quantity only. Rows match by SKU. Unknown SKUs are skipped.
 * Prices, photos, and names are never changed.
 */
export async function importSpreadsheet(buffer) {
  const entries = readRows(buffer)
  const variants = await prisma.variant.findMany({
    include: { product: { select: { id: true, name: true } } },
  })

  const bySku = new Map(variants.map((variant) => [variant.sku.trim().toLowerCase(), variant]))
  const byNameDose = new Map(
    variants.map((variant) => [
      `${variant.product.name.trim().toLowerCase()}::${normalizeDose(variant.dose).toLowerCase()}`,
      variant,
    ]),
  )

  const summary = {
    rows: entries.length,
    variantsUpdated: 0,
    skipped: 0,
    skippedRows: [],
  }

  const seen = new Set()

  for (const entry of entries) {
    const skuMatch = entry.sku ? bySku.get(entry.sku.toLowerCase()) : null
    const nameMatch =
      entry.productName && entry.dose
        ? byNameDose.get(`${entry.productName.toLowerCase()}::${entry.dose.toLowerCase()}`)
        : null
    const variant = skuMatch || nameMatch

    if (!variant) {
      summary.skipped += 1
      summary.skippedRows.push(entry.sku || `${entry.productName} ${entry.dose}`.trim())
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

/** Live Excel the admin can fill in — SKU locked, Quantity is the editable column. */
export async function buildInventoryTemplate() {
  const products = await prisma.product.findMany({
    include: { variants: { orderBy: [{ sortOrder: 'asc' }, { dose: 'asc' }] } },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  })

  const inventoryRows = [
    ['SKU', 'Product', 'Dose', 'Quantity'],
    ...products.flatMap((product) =>
      product.variants.map((variant) => [
        variant.sku,
        product.name,
        variant.dose,
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
    ['SKU', 'Required. Matches the dose/variant. Do not change this value.'],
    ['Product', 'Shown for reference. Changing it does not rename the live product.'],
    ['Dose', 'Shown for reference (5mg, 10mg, etc.).'],
    ['Quantity', 'Edit this. Enter the new on-hand count (0 or more).'],
    [''],
    ['Rules'],
    ['1. Keep one row per dose. BPC-157 5mg and BPC-157 10mg are separate rows.'],
    ['2. Do not add extra header rows above SKU / Product / Dose / Quantity.'],
    ['3. Leave SKU exactly as exported. That is how the site finds the product.'],
    ['4. Upload the saved .xlsx from Admin → Products → Import Excel.'],
    ['5. Unknown SKUs are skipped. Prices, photos, and descriptions stay the same.'],
  ]

  const workbook = XLSX.utils.book_new()
  const inventory = XLSX.utils.aoa_to_sheet(inventoryRows)
  inventory['!cols'] = [{ wch: 22 }, { wch: 36 }, { wch: 12 }, { wch: 12 }]
  inventory['!autofilter'] = { ref: `A1:D${Math.max(inventoryRows.length, 1)}` }
  inventory['!freeze'] = { xSplit: 0, ySplit: 1 }

  const instructions = XLSX.utils.aoa_to_sheet(instructionRows)
  instructions['!cols'] = [{ wch: 18 }, { wch: 78 }]

  XLSX.utils.book_append_sheet(workbook, inventory, 'Inventory')
  XLSX.utils.book_append_sheet(workbook, instructions, 'Instructions')

  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })
}
