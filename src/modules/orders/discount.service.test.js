import assert from 'node:assert/strict'
import test from 'node:test'
import { calculateBulkDiscount } from './discount.service.js'

const tiers = [
  {
    id: 'ten',
    enabled: true,
    scope: 'ORDER',
    percent: 10,
    minSubtotalCents: 20_000,
    detail: 'Over $200',
  },
  {
    id: 'twenty',
    enabled: true,
    scope: 'ORDER',
    percent: 20,
    minSubtotalCents: 30_000,
    detail: 'Over $300',
  },
  {
    id: 'kits',
    enabled: true,
    scope: 'KIT',
    percent: 25,
    minSubtotalCents: 0,
    detail: 'Full kits',
  },
]

test('applies the best eligible order tier', () => {
  const result = calculateBulkDiscount(
    [{ unitPriceCents: 10_000, qty: 4, barcode: 'VIAL', category: 'Peptides' }],
    tiers,
  )
  assert.equal(result.discountCents, 8_000)
  assert.equal(result.tierId, 'twenty')
})

test('compares kit and order rewards without stacking', () => {
  const result = calculateBulkDiscount(
    [
      { unitPriceCents: 20_000, qty: 1, barcode: 'BPC-KIT', category: 'Peptides' },
      { unitPriceCents: 10_000, qty: 1, barcode: 'VIAL', category: 'Peptides' },
    ],
    tiers,
  )
  assert.equal(result.discountCents, 6_000)
  assert.equal(result.tierId, 'twenty')
})

test('applies kit reward only to kit lines', () => {
  const result = calculateBulkDiscount(
    [
      { unitPriceCents: 10_000, qty: 1, barcode: 'BPC-KIT', category: 'Peptides' },
      { unitPriceCents: 5_000, qty: 1, barcode: 'VIAL', category: 'Peptides' },
    ],
    tiers,
  )
  assert.equal(result.discountCents, 2_500)
  assert.equal(result.tierId, 'kits')
})

test('treats qty 10+ of one item as a full kit', () => {
  const result = calculateBulkDiscount(
    [{ unitPriceCents: 8_000, qty: 10, barcode: 'MOTS-C-10MG', category: 'Peptides' }],
    tiers,
  )
  // Kit 25% on $800 = $200, which beats order 20% on $800 = $160.
  assert.equal(result.discountCents, 20_000)
  assert.equal(result.tierId, 'kits')
})

test('excludes Other category from kit reward', () => {
  const result = calculateBulkDiscount(
    [
      {
        unitPriceCents: 5_000,
        qty: 10,
        barcode: 'BAC-WATER',
        productName: 'Research solvent',
        category: 'Other',
      },
    ],
    tiers,
  )
  // $500 cart: order 20% = $100. Kit 25% would be $125 if eligible — must not win.
  assert.equal(result.discountCents, 10_000)
  assert.equal(result.tierId, 'twenty')
})

test('excludes bacteriostatic water from kit reward by name', () => {
  const result = calculateBulkDiscount(
    [
      {
        unitPriceCents: 5_000,
        qty: 10,
        barcode: 'BW-10',
        productName: 'Bacteriostatic Water',
        category: 'Peptides',
      },
    ],
    tiers,
  )
  // Same $500 math: order tier wins because kit scope is blocked by name.
  assert.equal(result.discountCents, 10_000)
  assert.equal(result.tierId, 'twenty')
})

test('Other category kit-labeled lines get no kit discount under order thresholds', () => {
  const result = calculateBulkDiscount(
    [
      {
        unitPriceCents: 10_000,
        qty: 1,
        barcode: 'OTHER-KIT',
        productName: 'Accessory Kit',
        category: 'Other',
      },
    ],
    tiers,
  )
  assert.equal(result.discountCents, 0)
  assert.equal(result.tierId, null)
})

test('applies kit reward to Blends category', () => {
  const result = calculateBulkDiscount(
    [
      {
        unitPriceCents: 10_000,
        qty: 1,
        barcode: 'BLEND-KIT',
        productName: 'Research Blend Kit',
        category: 'Blends',
      },
    ],
    tiers,
  )
  assert.equal(result.discountCents, 2_500)
  assert.equal(result.tierId, 'kits')
})
