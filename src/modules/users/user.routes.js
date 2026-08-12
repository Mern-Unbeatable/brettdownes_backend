import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound } from '../../lib/http-error.js'
import { requireAdmin, invalidateUserCache } from '../../middleware/auth.js'
import { validate } from '../../middleware/validate.js'
import { sendMail } from '../../lib/mailer.js'
import { templates } from '../../lib/email-templates.js'

const listQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  status: z.enum(['PENDING', 'ACTIVE', 'BLOCKED']).optional(),
  role: z.enum(['USER', 'ADMIN']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
})

const statusSchema = z.object({ status: z.enum(['PENDING', 'ACTIVE', 'BLOCKED']) })
const roleSchema = z.object({ role: z.enum(['USER', 'ADMIN']) })

const SELECT = {
  id: true,
  email: true,
  name: true,
  company: true,
  phone: true,
  researchFramework: true,
  role: true,
  status: true,
  lastLoginAt: true,
  createdAt: true,
  _count: { select: { orders: true } },
}

function serialize(user) {
  const { _count, ...rest } = user
  return { ...rest, orderCount: _count?.orders ?? 0 }
}

/** Blocks an admin from locking themselves out or deleting their own account. */
function assertNotSelf(req, id, action) {
  if (req.user.id === id) throw badRequest(`You cannot ${action} your own account.`)
}

const router = Router()

router.use(requireAdmin)

router.get('/', validate(listQuerySchema, 'query'), async (req, res) => {
  const { search, status, role, page, perPage } = req.validatedQuery

  const where = {
    deletedAt: null,
    ...(status ? { status } : {}),
    ...(role ? { role } : {}),
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
            { company: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}),
  }

  const [users, total, counts] = await Promise.all([
    prisma.user.findMany({
      where,
      select: SELECT,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    prisma.user.count({ where }),
    prisma.user.groupBy({
      by: ['status'],
      where: { deletedAt: null },
      _count: { _all: true },
    }),
  ])

  res.json({
    users: users.map(serialize),
    total,
    page,
    perPage,
    pages: Math.max(1, Math.ceil(total / perPage)),
    stats: counts.reduce(
      (acc, row) => ({ ...acc, [row.status.toLowerCase()]: row._count._all }),
      { pending: 0, active: 0, blocked: 0 },
    ),
  })
})

router.get('/:id', async (req, res) => {
  const user = await prisma.user.findFirst({
    where: { id: req.params.id, deletedAt: null },
    select: {
      ...SELECT,
      addresses: true,
      orders: {
        select: {
          id: true,
          orderNumber: true,
          status: true,
          paymentStatus: true,
          totalCents: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
      },
    },
  })
  if (!user) throw notFound('Customer not found.')
  res.json({ user: serialize(user) })
})

router.patch('/:id/status', validate(statusSchema), async (req, res) => {
  const { id } = req.params
  const { status } = req.body

  const existing = await prisma.user.findFirst({ where: { id, deletedAt: null } })
  if (!existing) throw notFound('Customer not found.')
  if (status !== 'ACTIVE') assertNotSelf(req, id, 'suspend')

  const user = await prisma.user.update({ where: { id }, data: { status }, select: SELECT })
  invalidateUserCache(id)

  // Approving a pending account is the customer's cue that they can sign in.
  if (existing.status === 'PENDING' && status === 'ACTIVE') {
    sendMail({ to: user.email, ...templates.registrationApproved(user) })
  }

  res.json({ user: serialize(user) })
})

router.patch('/:id/role', validate(roleSchema), async (req, res) => {
  const { id } = req.params
  assertNotSelf(req, id, 'change the role of')

  const existing = await prisma.user.findFirst({ where: { id, deletedAt: null } })
  if (!existing) throw notFound('Customer not found.')

  const user = await prisma.user.update({
    where: { id },
    data: { role: req.body.role },
    select: SELECT,
  })
  invalidateUserCache(id)
  res.json({ user: serialize(user) })
})

router.delete('/:id', async (req, res) => {
  const { id } = req.params
  assertNotSelf(req, id, 'delete')

  const existing = await prisma.user.findFirst({ where: { id, deletedAt: null } })
  if (!existing) throw notFound('Customer not found.')

  // Soft delete keeps historical orders attributable while revoking access.
  await prisma.user.update({
    where: { id },
    data: {
      deletedAt: new Date(),
      status: 'BLOCKED',
      email: `deleted+${id}@peptideops.invalid`,
    },
  })
  invalidateUserCache(id)

  res.json({ ok: true })
})

export default router
