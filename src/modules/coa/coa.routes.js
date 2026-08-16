import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { notFound } from '../../lib/http-error.js'
import { requireAdmin, requireAuth } from '../../middleware/auth.js'
import { validate } from '../../middleware/validate.js'

const coaSchema = z.object({
  productId: z.string().uuid(),
  name: z.string().trim().min(1, 'Document name is required.').max(160),
  content: z.string().trim().max(20_000).default(''),
  documentUrl: z
    .string()
    .trim()
    .max(500)
    .refine((value) => !value || value.startsWith('/uploads/') || /^https?:\/\//i.test(value), {
      message: 'Document URL is not valid.',
    })
    .default(''),
  isPublished: z.boolean().default(true),
  sortOrder: z.coerce.number().int().min(0).max(100_000).default(0),
})

const includeProduct = {
  product: { select: { id: true, name: true, slug: true, image: true, category: true } },
}

function serialize(document) {
  return {
    id: document.id,
    productId: document.productId,
    name: document.name,
    content: document.content,
    documentUrl: document.documentUrl,
    isPublished: document.isPublished,
    sortOrder: document.sortOrder,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    product: document.product,
  }
}

const router = Router()

router.get('/', requireAuth, async (req, res) => {
  const documents = await prisma.coaDocument.findMany({
    where: { isPublished: true, product: { isActive: true } },
    include: includeProduct,
    orderBy: [{ product: { name: 'asc' } }, { sortOrder: 'asc' }, { createdAt: 'desc' }],
  })
  res.json({ documents: documents.map(serialize) })
})

router.get('/admin', requireAdmin, async (req, res) => {
  const documents = await prisma.coaDocument.findMany({
    include: includeProduct,
    orderBy: [{ product: { name: 'asc' } }, { sortOrder: 'asc' }, { createdAt: 'desc' }],
  })
  res.json({ documents: documents.map(serialize) })
})

router.post('/admin', requireAdmin, validate(coaSchema), async (req, res) => {
  const document = await prisma.coaDocument.create({
    data: req.body,
    include: includeProduct,
  })
  res.status(201).json({ document: serialize(document) })
})

router.patch('/admin/:id', requireAdmin, validate(coaSchema), async (req, res) => {
  const existing = await prisma.coaDocument.findUnique({ where: { id: req.params.id } })
  if (!existing) throw notFound('COA document not found.')
  const document = await prisma.coaDocument.update({
    where: { id: existing.id },
    data: req.body,
    include: includeProduct,
  })
  res.json({ document: serialize(document) })
})

router.delete('/admin/:id', requireAdmin, async (req, res) => {
  const existing = await prisma.coaDocument.findUnique({ where: { id: req.params.id } })
  if (!existing) throw notFound('COA document not found.')
  await prisma.coaDocument.delete({ where: { id: existing.id } })
  res.json({ ok: true })
})

export default router
