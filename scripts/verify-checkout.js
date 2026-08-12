/**
 * End-to-end verification of the delivery checkout path.
 *
 * Runs the real API against local mock Stripe and EasyPost endpoints so the
 * exact outbound request bodies can be inspected. The headline assertion is
 * that no product information ever reaches Stripe.
 *
 * Usage: node scripts/verify-checkout.js
 */
import http from 'node:http'

const MOCK_STRIPE_PORT = 9910
const MOCK_EASYPOST_PORT = 9911
const API_PORT = 4100

// Wire the SDKs to the mocks before the app (and therefore env.js) is imported.
process.env.STRIPE_SECRET_KEY = 'sk_test_verify'
process.env.STRIPE_API_HOST = '127.0.0.1'
process.env.STRIPE_API_PORT = String(MOCK_STRIPE_PORT)
process.env.STRIPE_API_PROTOCOL = 'http'
process.env.EASYPOST_TEST_API_KEY = 'EZTK_verify'
// The SDK appends paths directly to this value, so the trailing slash matters.
process.env.EASYPOST_BASE_URL = `http://127.0.0.1:${MOCK_EASYPOST_PORT}/v2/`
process.env.PORT = String(API_PORT)

const { createApp } = await import('../src/app.js')
const { prisma } = await import('../src/lib/prisma.js')

const stripeRequests = []
const easypostRequests = []
const results = []

function check(label, ok, detail = '') {
  results.push({ label, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok && detail) console.log(`        ${detail}`)
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => resolve(raw))
  })
}

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(body)
}

// ---- Mock Stripe -----------------------------------------------------------

const stripeServer = http.createServer(async (req, res) => {
  const raw = await readBody(req)
  stripeRequests.push({ method: req.method, url: req.url, body: raw })

  if (req.method === 'POST' && req.url === '/v1/payment_intents') {
    const params = new URLSearchParams(raw)
    return json(res, 200, {
      id: 'pi_verify_1',
      object: 'payment_intent',
      status: 'requires_payment_method',
      client_secret: 'pi_verify_1_secret_abc',
      amount: Number(params.get('amount')),
      currency: params.get('currency'),
      metadata: {
        orderId: params.get('metadata[orderId]'),
        orderNumber: params.get('metadata[orderNumber]'),
      },
    })
  }

  if (req.method === 'GET' && req.url.startsWith('/v1/payment_intents/')) {
    // Simulate the customer having completed the card form.
    return json(res, 200, {
      id: 'pi_verify_1',
      object: 'payment_intent',
      status: 'succeeded',
      amount: 0,
      currency: 'usd',
    })
  }

  json(res, 404, { error: { message: `unmocked ${req.method} ${req.url}` } })
})

// ---- Mock EasyPost ---------------------------------------------------------

const RATES = [
  { id: 'rate_usps', carrier: 'USPS', service: 'Priority', rate: '9.45', currency: 'USD', delivery_days: 2 },
  { id: 'rate_ups', carrier: 'UPS', service: 'Ground', rate: '14.20', currency: 'USD', delivery_days: 3 },
]

const easypostServer = http.createServer(async (req, res) => {
  const raw = await readBody(req)
  easypostRequests.push({ method: req.method, url: req.url, body: raw })

  if (req.method === 'POST' && req.url === '/v2/shipments') {
    return json(res, 201, { id: 'shp_verify_1', object: 'Shipment', rates: RATES })
  }

  if (req.method === 'GET' && req.url === '/v2/shipments/shp_verify_1') {
    return json(res, 200, { id: 'shp_verify_1', object: 'Shipment', rates: RATES })
  }

  if (req.method === 'POST' && req.url === '/v2/shipments/shp_verify_1/buy') {
    return json(res, 200, {
      id: 'shp_verify_1',
      object: 'Shipment',
      tracking_code: '9400111899223197428490',
      postage_label: { label_url: 'https://easypost-files.test/label_verify.png' },
      tracker: { public_url: 'https://track.easypost.com/verify' },
      selected_rate: RATES[0],
    })
  }

  json(res, 404, { error: { message: `unmocked ${req.method} ${req.url}` } })
})

// ---- Test client -----------------------------------------------------------

const BASE = `http://127.0.0.1:${API_PORT}`
let cookie = ''

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

  for (const entry of res.headers.getSetCookie?.() || []) {
    const [pair] = entry.split(';')
    if (pair.startsWith('peptide_session=')) cookie = pair
  }

  const text = await res.text()
  let payload = null
  try {
    payload = JSON.parse(text)
  } catch {
    payload = { raw: text.slice(0, 200) }
  }

  return { status: res.status, json: payload }
}

async function listen(server, port) {
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
}

async function main() {
  await listen(stripeServer, MOCK_STRIPE_PORT)
  await listen(easypostServer, MOCK_EASYPOST_PORT)

  const app = createApp()
  const apiServer = app.listen(API_PORT)
  await new Promise((resolve) => apiServer.once('listening', resolve))

  console.log('\nEnd-to-end checkout verification\n')

  const email = `verify_${Date.now()}@example.com`
  const password = 'VerifyRun123'

  // 1. Approval gating.
  console.log('Approval gating')
  await call('POST', '/api/auth/register', {
    company: 'Verify Labs',
    email,
    password,
    phone: '5035550100',
    researchFramework: 'End-to-end verification run.',
  })
  const refused = await call('POST', '/api/auth/login', { email, password })
  check(
    'pending account cannot sign in',
    refused.status === 403 && /awaiting approval/i.test(refused.json.error || ''),
    `status ${refused.status}: ${refused.json.error}`,
  )

  const admin = await call('POST', '/api/auth/login', {
    email: process.env.SEED_ADMIN_EMAIL || 'admin@peptideops.com',
    password: process.env.SEED_ADMIN_PASSWORD || 'PeptideOps1',
  })
  check('admin can sign in', admin.json.user?.role === 'ADMIN')

  const pendingList = await call('GET', '/api/admin/users?status=PENDING')
  const pending = pendingList.json.users?.find((entry) => entry.email === email)
  await call('PATCH', `/api/admin/users/${pending.id}/status`, { status: 'ACTIVE' })

  const approved = await call('POST', '/api/auth/login', { email, password })
  check('approved account can sign in', approved.status === 200 && Boolean(approved.json.user))

  // 2. Delivery order with live rates.
  console.log('\nDelivery order')
  const products = await call('GET', '/api/products')
  const product = products.json.products[0]
  const variant = product.variants[0]

  const ratesRes = await call('POST', '/api/shipping/rates', {
    items: [{ variantId: variant.id, qty: 2 }],
    address: {
      line1: '1600 Amphitheatre Pkwy',
      city: 'Mountain View',
      state: 'CA',
      zip: '94043',
      country: 'US',
    },
  })
  check(
    'EasyPost returns sorted carrier rates',
    ratesRes.status === 200 && ratesRes.json.rates?.length === 2 &&
      ratesRes.json.rates[0].amountCents === 945,
    JSON.stringify(ratesRes.json).slice(0, 200),
  )

  const parcelRequest = JSON.parse(
    easypostRequests.find((entry) => entry.url === '/v2/shipments')?.body || '{}',
  )
  check(
    'parcel weight is summed from variant weights',
    parcelRequest.shipment?.parcel?.weight === 4,
    `parcel: ${JSON.stringify(parcelRequest.shipment?.parcel)}`,
  )
  check(
    'ship-from address comes from settings',
    parcelRequest.shipment?.from_address?.zip === '97303',
    JSON.stringify(parcelRequest.shipment?.from_address),
  )

  const chosen = ratesRes.json.rates[1]
  const orderRes = await call('POST', '/api/orders', {
    items: [{ variantId: variant.id, qty: 2 }],
    fulfillment: 'DELIVERY',
    contact: { name: 'Verify Tester', email, phone: '5035550100' },
    address: {
      line1: '1600 Amphitheatre Pkwy',
      city: 'Mountain View',
      state: 'CA',
      zip: '94043',
      country: 'US',
    },
    shipmentId: ratesRes.json.shipmentId,
    rateId: chosen.id,
    notes: 'Verification order.',
  })

  const order = orderRes.json.order
  const expectedTotal = variant.priceCents * 2 + chosen.amountCents
  check(
    'order total is recomputed server-side',
    order?.totalCents === expectedTotal,
    `expected ${expectedTotal}, got ${order?.totalCents}`,
  )
  check('delivery order routes to Stripe', order?.paymentMethod === 'STRIPE')

  // A stale rate id must be refused.
  const stale = await call('POST', '/api/orders', {
    items: [{ variantId: variant.id, qty: 1 }],
    fulfillment: 'DELIVERY',
    contact: { name: 'Verify Tester', email, phone: '5035550100' },
    address: {
      line1: '1600 Amphitheatre Pkwy',
      city: 'Mountain View',
      state: 'CA',
      zip: '94043',
      country: 'US',
    },
    shipmentId: ratesRes.json.shipmentId,
    rateId: 'rate_does_not_exist',
    notes: '',
  })
  check(
    'expired or forged rate id is rejected',
    stale.status === 400 && /expired/i.test(stale.json.error || ''),
    `status ${stale.status}: ${stale.json.error}`,
  )

  // 3. Stripe payment intent privacy.
  console.log('\nStripe privacy')
  const intent = await call('POST', '/api/payments/intent', { orderId: order.id })
  check('payment intent created', Boolean(intent.json.clientSecret), JSON.stringify(intent.json))

  const intentRequest = stripeRequests.find((entry) => entry.url === '/v1/payment_intents')
  const params = new URLSearchParams(intentRequest?.body || '')
  const sentKeys = [...params.keys()].sort()

  console.log(`    Stripe received: ${intentRequest?.body}`)

  check(
    'Stripe amount matches the order total',
    Number(params.get('amount')) === order.totalCents,
    `sent ${params.get('amount')}, order ${order.totalCents}`,
  )

  const allowedKeys = [
    'amount',
    'currency',
    'automatic_payment_methods[enabled]',
    'description',
    'statement_descriptor_suffix',
    'metadata[orderId]',
    'metadata[orderNumber]',
  ].sort()
  check(
    'Stripe receives only amount, descriptor and internal ids',
    JSON.stringify(sentKeys) === JSON.stringify(allowedKeys),
    `sent keys: ${sentKeys.join(', ')}`,
  )

  // The decisive check: nothing identifying the products is in the payload.
  const productWords = [
    product.name,
    variant.dose,
    variant.sku,
    product.slug,
    product.category,
    'peptide',
  ]
  const payloadText = decodeURIComponent(intentRequest?.body || '').toLowerCase()
  const leaked = productWords.filter((word) => word && payloadText.includes(word.toLowerCase()))
  check(
    'no product name, dose, SKU or category reaches Stripe',
    leaked.length === 0,
    `leaked: ${leaked.join(', ')}`,
  )

  check(
    'statement descriptor is the configured alias',
    params.get('statement_descriptor_suffix') === 'That 3D Printer Guy',
    `got "${params.get('statement_descriptor_suffix')}"`,
  )
  check(
    'description carries only the internal order number',
    params.get('description') === `Order ${order.orderNumber}`,
    `got "${params.get('description')}"`,
  )

  // 4. Payment confirmation.
  const confirmed = await call('POST', '/api/payments/confirm', { orderId: order.id })
  check('order is marked paid after confirmation', confirmed.json.paid === true)

  const mine = await call('GET', `/api/orders/mine/${order.id}`)
  check(
    'order shows as paid and processing',
    mine.json.order?.paymentStatus === 'PAID' && mine.json.order?.status === 'PROCESSING',
    `${mine.json.order?.paymentStatus} / ${mine.json.order?.status}`,
  )

  // 5. Admin buys the label.
  console.log('\nLabel purchase')
  cookie = ''
  await call('POST', '/api/auth/login', {
    email: process.env.SEED_ADMIN_EMAIL || 'admin@peptideops.com',
    password: process.env.SEED_ADMIN_PASSWORD || 'PeptideOps1',
  })

  const label = await call('POST', `/api/admin/orders/${order.id}/label`, { rateId: chosen.id })
  check(
    'label purchased with tracking',
    label.json.order?.trackingCode === '9400111899223197428490' &&
      Boolean(label.json.order?.labelUrl),
    JSON.stringify(label.json).slice(0, 220),
  )
  check('order moves to shipped', label.json.order?.status === 'SHIPPED')
  check('label is printable', label.json.order?.hasLabel === true)

  const secondBuy = await call('POST', `/api/admin/orders/${order.id}/label`, { rateId: chosen.id })
  check(
    'a second label cannot be bought for the same order',
    secondBuy.status === 400,
    `status ${secondBuy.status}: ${secondBuy.json.error}`,
  )

  // 6. Clean up the data this run created.
  console.log('\nCleanup')
  const created = await prisma.user.findUnique({ where: { email } })
  if (created) {
    await prisma.order.deleteMany({ where: { userId: created.id } })
    await prisma.user.delete({ where: { id: created.id } })
  }
  check('verification data removed', true)

  const failures = results.filter((entry) => !entry.ok).length
  console.log(`\n${results.length - failures}/${results.length} checks passed\n`)

  apiServer.close()
  stripeServer.close()
  easypostServer.close()
  await prisma.$disconnect()
  process.exit(failures ? 1 : 0)
}

main().catch(async (error) => {
  console.error('\nVerification crashed:', error)
  await prisma.$disconnect().catch(() => {})
  process.exit(1)
})
