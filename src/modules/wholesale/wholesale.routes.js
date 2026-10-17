import { Router } from 'express'
import { requireAdmin } from '../../middleware/auth.js'
import { validate } from '../../middleware/validate.js'
import { rateLimit } from '../../middleware/rate-limit.js'
import { badRequest, notFound, unauthorized } from '../../lib/http-error.js'
import { env } from '../../lib/env.js'
import { getStripe, sanitizeDescriptor } from '../../lib/stripe.js'
import { sendMail } from '../../lib/mailer.js'
import { templates } from '../../lib/email-templates.js'
import { getAdminRecipients, getSettings } from '../settings/settings.service.js'
import {
  categoryCreateSchema,
  categoryUpdateSchema,
  changePasswordSchema,
  checkoutSchema,
  configUpdateSchema,
  confirmSchema,
  couponSchema,
  orderPaymentSchema,
  orderStatusSchema,
  orderTrackingSchema,
  productCreateSchema,
  productUpdateSchema,
  ratesSchema,
  unlockSchema,
} from './wholesale.schemas.js'
import {
  attachWholesaleSession,
  changeAccessPassword,
  createCategory,
  createPendingWholesaleOrder,
  createProduct,
  deleteCategory,
  deleteProduct,
  deleteWholesaleOrder,
  getWholesaleCatalog,
  getWholesaleConfig,
  getWholesaleOrder,
  listWholesaleOrders,
  markWholesaleOrderPaid,
  refreshWholesaleOrderTracking,
  quoteWholesaleRates,
  serializeWholesaleOrder,
  validateWholesaleCoupon,
  setWholesaleOrderTracking,
  updateCategory,
  updateProduct,
  updateWholesaleConfig,
  updateWholesaleOrderPayment,
  updateWholesaleOrderStatus,
  verifyAccessPassword,
} from './wholesale.service.js'

const router = Router()

const unlockThrottle = rateLimit({
  windowMs: 60_000,
  max: 12,
  message: 'Too many attempts. Please wait a minute and try again.',
})

const checkoutThrottle = rateLimit({
  windowMs: 60_000,
  max: 10,
  message: 'Too many attempts. Please wait a minute and try again.',
})

/* ---- Public: unlock + read the price list ------------------------- */
router.post('/unlock', unlockThrottle, validate(unlockSchema), async (req, res) => {
  const ok = await verifyAccessPassword(req.body.password)
  if (!ok) throw unauthorized('Incorrect access password.')
  const [categories, config] = await Promise.all([getWholesaleCatalog(), getWholesaleConfig()])
  res.json({ ok: true, categories, config })
})

/* ---- Public: live carrier rates (same EasyPost flow as the shop) --- */
router.post('/rates', checkoutThrottle, validate(ratesSchema), async (req, res) => {
  const quote = await quoteWholesaleRates(req.body)
  res.json(quote)
})

/* ---- Public: validate a coupon against the private-store cart ------ */
router.post('/validate-coupon', checkoutThrottle, validate(couponSchema), async (req, res) => {
  const coupon = await validateWholesaleCoupon(req.body)
  res.json({ coupon })
})

/* ---- Public: guest Stripe checkout (hosted Stripe Checkout) -------- */
router.post('/checkout', checkoutThrottle, validate(checkoutSchema), async (req, res) => {
  const order = await createPendingWholesaleOrder(req.body)

  const settings = await getSettings()
  const stripe = getStripe()
  const descriptor = sanitizeDescriptor(settings.statementDescriptor)
  const clientUrl = env.clientUrl.replace(/\/$/, '')

  // Hosted Stripe Checkout — same payment page the main store uses.
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: order.contactEmail,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: order.currency || 'usd',
          unit_amount: order.totalCents,
          product_data: { name: 'Order payment' },
        },
      },
    ],
    metadata: { wholesaleOrderId: order.id, orderNumber: order.orderNumber },
    payment_intent_data: {
      statement_descriptor_suffix: descriptor || undefined,
      metadata: { wholesaleOrderId: order.id, orderNumber: order.orderNumber },
    },
    success_url: `${clientUrl}/other?checkout=success&orderId=${encodeURIComponent(order.id)}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${clientUrl}/other?checkout=cancel&orderId=${encodeURIComponent(order.id)}`,
  })

  await attachWholesaleSession(order.id, session.id)

  res.status(201).json({ url: session.url, orderId: order.id })
})

/** Verifies the Checkout Session completed, marks the order paid and emails both sides. */
router.post('/checkout/confirm', checkoutThrottle, validate(confirmSchema), async (req, res) => {
  const order = await getWholesaleOrder(req.body.orderId)
  if (order.paymentStatus === 'PAID') {
    return res.json({ paid: true, order: serializeWholesaleOrder(order) })
  }

  const session = await getStripe().checkout.sessions.retrieve(req.body.sessionId)
  const sessionOrderId = session.metadata?.wholesaleOrderId
  if (sessionOrderId && sessionOrderId !== order.id) {
    throw badRequest('This payment session does not match the order.')
  }
  if (session.payment_status !== 'paid' && session.status !== 'complete') {
    return res.json({ paid: false, status: session.status })
  }

  const paid = await markWholesaleOrderPaid(order.id)
  const fresh = paid || (await getWholesaleOrder(order.id))

  if (paid) {
    const settings = await getSettings()
    const serialized = serializeWholesaleOrder(fresh)
    sendMail({ to: fresh.contactEmail, ...templates.storeOrderConfirmation(serialized) })
    if (settings.notifyNewOrder) {
      sendMail({
        to: await getAdminRecipients(settings),
        ...templates.storeAdminNewOrder(serialized),
      })
    }
  }

  res.json({ paid: true, order: serializeWholesaleOrder(fresh) })
})

/* ---- Admin: manage the price list --------------------------------- */
router.get('/admin', requireAdmin, async (req, res) => {
  const [categories, config] = await Promise.all([getWholesaleCatalog(), getWholesaleConfig()])
  res.json({ categories, config })
})

router.patch(
  '/admin/password',
  requireAdmin,
  validate(changePasswordSchema),
  async (req, res) => {
    const result = await changeAccessPassword(req.body)
    res.json(result)
  },
)

router.patch('/admin/config', requireAdmin, validate(configUpdateSchema), async (req, res) => {
  const config = await updateWholesaleConfig(req.body)
  res.json({ config })
})

router.post(
  '/admin/categories',
  requireAdmin,
  validate(categoryCreateSchema),
  async (req, res) => {
    const category = await createCategory(req.body)
    res.status(201).json({ category })
  },
)

router.patch(
  '/admin/categories/:id',
  requireAdmin,
  validate(categoryUpdateSchema),
  async (req, res) => {
    const category = await updateCategory(req.params.id, req.body)
    res.json({ category })
  },
)

router.delete('/admin/categories/:id', requireAdmin, async (req, res) => {
  const result = await deleteCategory(req.params.id)
  res.json(result)
})

router.post(
  '/admin/products',
  requireAdmin,
  validate(productCreateSchema),
  async (req, res) => {
    const product = await createProduct(req.body)
    res.status(201).json({ product })
  },
)

router.patch(
  '/admin/products/:id',
  requireAdmin,
  validate(productUpdateSchema),
  async (req, res) => {
    const product = await updateProduct(req.params.id, req.body)
    res.json({ product })
  },
)

router.delete('/admin/products/:id', requireAdmin, async (req, res) => {
  const result = await deleteProduct(req.params.id)
  res.json(result)
})

/* ---- Admin: "Other" store orders ---------------------------------- */
router.get('/admin/orders', requireAdmin, async (req, res) => {
  const orders = await listWholesaleOrders({
    status: req.query.status || undefined,
    search: req.query.search || undefined,
  })
  res.json({ orders, total: orders.length })
})

router.get('/admin/orders/:id', requireAdmin, async (req, res) => {
  let order = await getWholesaleOrder(req.params.id)
  order = await refreshWholesaleOrderTracking(order)
  res.json({ order: serializeWholesaleOrder(order) })
})

router.patch(
  '/admin/orders/:id/status',
  requireAdmin,
  validate(orderStatusSchema),
  async (req, res) => {
    const order = await updateWholesaleOrderStatus(req.params.id, req.body.status)
    const serialized = serializeWholesaleOrder(order)
    sendMail({ to: order.contactEmail, ...templates.storeOrderStatusChanged(serialized) })
    res.json({ order: serialized })
  },
)

router.patch(
  '/admin/orders/:id/payment',
  requireAdmin,
  validate(orderPaymentSchema),
  async (req, res) => {
    const order = await updateWholesaleOrderPayment(req.params.id, req.body.paymentStatus)
    res.json({ order: serializeWholesaleOrder(order) })
  },
)

router.post(
  '/admin/orders/:id/tracking',
  requireAdmin,
  validate(orderTrackingSchema),
  async (req, res) => {
    const order = await setWholesaleOrderTracking(req.params.id, req.body)
    const serialized = serializeWholesaleOrder(order)
    sendMail({ to: order.contactEmail, ...templates.storeOrderShipped(serialized) })
    res.json({ order: serialized })
  },
)

router.delete('/admin/orders/:id', requireAdmin, async (req, res) => {
  if (!(await getWholesaleOrder(req.params.id).catch(() => null))) throw notFound('Order not found.')
  const result = await deleteWholesaleOrder(req.params.id)
  res.json(result)
})

export default router
