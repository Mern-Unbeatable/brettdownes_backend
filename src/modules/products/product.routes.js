import { Router } from 'express'
import multer from 'multer'
import { requireAdmin, requireAuth } from '../../middleware/auth.js'
import { validate } from '../../middleware/validate.js'
import { badRequest } from '../../lib/http-error.js'
import * as controller from './product.controller.js'
import { importSpreadsheet } from './product.import.js'
import {
  productCreateSchema,
  productQuerySchema,
  productUpdateSchema,
  variantInputSchema,
  variantUpdateSchema,
} from './product.schemas.js'

const router = Router()
const spreadsheetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter(req, file, cb) {
    const name = String(file.originalname || '').toLowerCase()
    const ok =
      name.endsWith('.xlsx') ||
      name.endsWith('.xls') ||
      name.endsWith('.csv') ||
      file.mimetype.includes('sheet') ||
      file.mimetype.includes('excel') ||
      file.mimetype === 'text/csv'
    if (!ok) return cb(badRequest('Upload an Excel (.xlsx) or CSV inventory file.'))
    cb(null, true)
  },
})

// The storefront sits behind the portal gate, so the catalogue requires a session.
router.get('/', requireAuth, validate(productQuerySchema, 'query'), controller.listProducts)
router.get('/featured', requireAuth, controller.listFeaturedProducts)
router.post('/', requireAdmin, validate(productCreateSchema), controller.createProduct)

router.post('/import', requireAdmin, (req, res, next) => {
  spreadsheetUpload.single('file')(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(badRequest('Spreadsheet must be smaller than 8MB.'))
      }
      return next(err)
    }
    try {
      if (!req.file?.buffer) throw badRequest('No spreadsheet was uploaded.')
      const result = await importSpreadsheet(req.file.buffer)
      res.json(result)
    } catch (error) {
      next(error)
    }
  })
})

router.post('/:id/variants', requireAdmin, validate(variantInputSchema), controller.createVariant)
router.patch(
  '/variants/:variantId',
  requireAdmin,
  validate(variantUpdateSchema),
  controller.updateVariant,
)
router.delete('/variants/:variantId', requireAdmin, controller.deleteVariant)

router.patch('/:id', requireAdmin, validate(productUpdateSchema), controller.updateProduct)
router.delete('/:id', requireAdmin, controller.deleteProduct)

// Declared last so it never shadows /variants or /import.
router.get('/:slug', requireAuth, controller.getProduct)

export default router
