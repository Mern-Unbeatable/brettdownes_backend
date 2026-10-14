import { Router } from 'express'
import { requireAdmin } from '../../middleware/auth.js'
import { validate } from '../../middleware/validate.js'
import { rateLimit } from '../../middleware/rate-limit.js'
import { unauthorized } from '../../lib/http-error.js'
import {
  categoryCreateSchema,
  categoryUpdateSchema,
  changePasswordSchema,
  productCreateSchema,
  productUpdateSchema,
  unlockSchema,
} from './wholesale.schemas.js'
import {
  changeAccessPassword,
  createCategory,
  createProduct,
  deleteCategory,
  deleteProduct,
  getWholesaleCatalog,
  updateCategory,
  updateProduct,
  verifyAccessPassword,
} from './wholesale.service.js'

const router = Router()

const unlockThrottle = rateLimit({
  windowMs: 60_000,
  max: 12,
  message: 'Too many attempts. Please wait a minute and try again.',
})

/* ---- Public: unlock + read the price list ------------------------- */
router.post('/unlock', unlockThrottle, validate(unlockSchema), async (req, res) => {
  const ok = await verifyAccessPassword(req.body.password)
  if (!ok) throw unauthorized('Incorrect access password.')
  const categories = await getWholesaleCatalog()
  res.json({ ok: true, categories })
})

/* ---- Admin: manage the price list --------------------------------- */
router.get('/admin', requireAdmin, async (req, res) => {
  const categories = await getWholesaleCatalog()
  res.json({ categories })
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

export default router
