import assert from 'node:assert/strict'
import test from 'node:test'
import { buildParcel } from './easypost.js'

test('uses the small box for one bottle', () => {
  assert.deepEqual(buildParcel([{ qty: 1 }]), {
    length: 6,
    width: 4,
    height: 2,
    weight: 8,
  })
})

test('uses the small box through eight bottles', () => {
  assert.deepEqual(buildParcel([{ qty: 3 }, { qty: 5 }]), {
    length: 6,
    width: 4,
    height: 2,
    weight: 29,
  })
})

test('switches to the large box at nine bottles', () => {
  assert.deepEqual(buildParcel([{ qty: 9 }]), {
    length: 9,
    width: 6,
    height: 4,
    weight: 33,
  })
})

test('uses the large box through forty bottles', () => {
  assert.deepEqual(buildParcel([{ qty: 40 }]), {
    length: 9,
    width: 6,
    height: 4,
    weight: 126,
  })
})
