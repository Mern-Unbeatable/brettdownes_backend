/**
 * Exercises the main API flows against a running dev server.
 * Usage: node scripts/smoke.js
 */
const BASE = process.env.SMOKE_BASE || 'http://localhost:4000'

let cookie = ''
const results = []

async function call(method, path, body, { expect } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

  const setCookie = res.headers.getSetCookie?.() || []
  for (const entry of setCookie) {
    const [pair] = entry.split(';')
    if (pair.startsWith('peptide_session=')) cookie = pair
  }

  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = { raw: text.slice(0, 200) }
  }

  const ok = expect ? res.status === expect : res.ok
  results.push({ ok, label: `${method} ${path}`, status: res.status, detail: ok ? '' : text.slice(0, 220) })
  return { status: res.status, json }
}

function log(label, value) {
  console.log(`   ${label}: ${value}`)
}

async function main() {
  console.log(`\nSmoke testing ${BASE}\n`)

  await call('GET', '/api/health')

  // Unauthenticated access must be refused.
  await call('GET', '/api/products', null, { expect: 401 })

  const me0 = await call('GET', '/api/auth/me')
  log('anonymous user', JSON.stringify(me0.json.user))

  // Registration while auto-approval is off should land in PENDING.
  const email = `smoke_${Date.now()}@example.com`
  const reg = await call('POST', '/api/auth/register', {
    company: 'Smoke Labs',
    email,
    password: 'SmokeTest123',
    phone: '5035550123',
    researchFramework: 'Automated API smoke test.',
  })
  log('registered status', reg.json.user?.status)

  // A pending account must not be able to sign in.
  const blocked = await call('POST', '/api/auth/login', { email, password: 'SmokeTest123' }, { expect: 403 })
  log('pending login message', blocked.json.error)

  // Admin login.
  const admin = await call('POST', '/api/auth/login', {
    email: process.env.SEED_ADMIN_EMAIL || 'admin@peptideops.com',
    password: process.env.SEED_ADMIN_PASSWORD || 'PeptideOps1',
  })
  log('admin role', admin.json.user?.role)

  const products = await call('GET', '/api/products')
  log('products', products.json.products?.length)
  const variant = products.json.products?.[0]?.variants?.[0]
  log('first variant', `${products.json.products?.[0]?.name} ${variant?.dose} $${variant?.price}`)

  await call('GET', '/api/settings')
  const pub = await call('GET', '/api/settings/public')
  log('public keys', Object.keys(pub.json.settings || {}).join(', '))

  const users = await call('GET', '/api/admin/users?status=PENDING')
  log('pending users', users.json.total)

  const pending = users.json.users?.find((u) => u.email === email)
  if (pending) {
    await call('PATCH', `/api/admin/users/${pending.id}/status`, { status: 'ACTIVE' })
    log('approved', pending.email)
  }

  await call('GET', '/api/admin/orders/stats')
  await call('GET', '/api/admin/orders')

  // Product CRUD.
  const created = await call('POST', '/api/products', {
    name: 'Smoke Test Peptide',
    category: 'Peptides',
    summary: 'Temporary product created by the smoke test.',
    variants: [{ dose: '5mg', price: 42.5, sku: `SMOKE-${Date.now()}`, stock: 3, weightOz: 2 }],
  })
  const productId = created.json.product?.id
  log('created product', `${created.json.product?.slug} / ${created.json.product?.variants?.[0]?.price}`)

  if (productId) {
    await call('PATCH', `/api/products/${productId}`, { summary: 'Updated by smoke test.' })
    await call('DELETE', `/api/products/${productId}`)
    log('cleaned up product', productId)
  }

  // Now act as the approved customer.
  await call('POST', '/api/auth/logout')
  cookie = ''
  const customer = await call('POST', '/api/auth/login', { email, password: 'SmokeTest123' })
  log('customer login', customer.json.user?.email)

  // Pickup order needs no EasyPost or Stripe credentials.
  const publicSettings = await call('GET', '/api/settings/public')
  const pickupLocationId =
    publicSettings.json.settings?.pickupLocations?.[0]?.id ||
    publicSettings.json.settings?.pickupAddress?.id ||
    'default-keizer'

  const order = await call('POST', '/api/orders', {
    items: [{ variantId: variant.id, qty: 2 }],
    fulfillment: 'PICKUP',
    pickupLocationId,
    contact: { name: 'Smoke Tester', email, phone: '5035550123' },
    notes: 'Smoke test pickup order.',
  })
  log(
    'pickup order',
    `${order.json.order?.orderNumber} subtotal $${order.json.order?.subtotal} total $${order.json.order?.total}`,
  )

  // Server-side pricing must ignore any client-supplied price.
  const tampered = await call('POST', '/api/orders', {
    items: [{ variantId: variant.id, qty: 1, price: 0.01, unitPriceCents: 1 }],
    fulfillment: 'PICKUP',
    pickupLocationId,
    contact: { name: 'Smoke Tester', email, phone: '5035550123' },
  })
  const expectedCents = variant.priceCents
  const gotCents = tampered.json.order?.subtotalCents
  results.push({
    ok: gotCents === expectedCents,
    label: 'price tampering ignored',
    status: gotCents === expectedCents ? 'pass' : 'FAIL',
    detail: gotCents === expectedCents ? '' : `expected ${expectedCents} got ${gotCents}`,
  })

  // A delivery order without a rate must be rejected.
  await call(
    'POST',
    '/api/orders',
    {
      items: [{ variantId: variant.id, qty: 1 }],
      fulfillment: 'DELIVERY',
      contact: { name: 'Smoke Tester', email, phone: '5035550123' },
      address: { line1: '123 Main St', city: 'Keizer', state: 'OR', zip: '97303', country: 'US' },
    },
    { expect: 400 },
  )

  const mine = await call('GET', '/api/orders/mine')
  log('my orders', mine.json.orders?.length)

  // Customers must not reach admin endpoints.
  await call('GET', '/api/admin/users', null, { expect: 403 })
  await call('POST', '/api/products', { name: 'nope', variants: [] }, { expect: 403 })

  console.log('\nResults')
  let failures = 0
  for (const result of results) {
    if (!result.ok) failures += 1
    console.log(`  ${result.ok ? 'PASS' : 'FAIL'}  ${String(result.status).padEnd(4)} ${result.label}`)
    if (result.detail) console.log(`        ${result.detail}`)
  }
  console.log(`\n${results.length - failures}/${results.length} checks passed\n`)
  process.exit(failures ? 1 : 0)
}

main().catch((error) => {
  console.error('Smoke run crashed:', error)
  process.exit(1)
})
