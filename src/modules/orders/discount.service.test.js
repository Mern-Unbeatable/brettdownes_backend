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
    [{ unitPriceCents: 10_000, qty: 4, sku: 'VIAL' }],
    tiers,
  )
  assert.equal(result.discountCents, 8_000)
  assert.equal(result.tierId, 'twenty')
})

test('compares kit and order rewards without stacking', () => {
  const result = calculateBulkDiscount(
    [
      { unitPriceCents: 20_000, qty: 1, sku: 'BPC-KIT' },
      { unitPriceCents: 10_000, qty: 1, sku: 'VIAL' },
    ],
    tiers,
  )
  assert.equal(result.discountCents, 6_000)
  assert.equal(result.tierId, 'twenty')
})

test('applies kit reward only to kit lines', () => {
  const result = calculateBulkDiscount(
    [
      { unitPriceCents: 10_000, qty: 1, sku: 'BPC-KIT' },
      { unitPriceCents: 5_000, qty: 1, sku: 'VIAL' },
    ],
    tiers,
  )
  assert.equal(result.discountCents, 2_500)
  assert.equal(result.tierId, 'kits')
})
