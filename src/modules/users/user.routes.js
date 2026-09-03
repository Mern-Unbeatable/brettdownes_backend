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

const exportQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  status: z.enum(['PENDING', 'ACTIVE', 'BLOCKED']).optional(),
  role: z.enum(['USER', 'ADMIN']).optional(),
})

const statusSchema = z.object({ status: z.enum(['PENDING', 'ACTIVE', 'BLOCKED']) })
const roleSchema = z.object({ role: z.enum(['USER', 'ADMIN']) })
const creditSchema = z.object({
  // Admin sets an absolute dollar balance (e.g. 25.00 → 2500 cents).
  creditDollars: z.coerce.number().min(0).max(100000),
})
const heardAboutSchema = z.object({
  heardAboutUs: z.string().trim().max(120).optional().or(z.literal('')),
})

const SELECT = {
  id: true,
  email: true,
  name: true,
  company: true,
  phone: true,
  researchFramework: true,
  heardAboutUs: true,
  creditCents: true,
  role: true,
  status: true,
  lastLoginAt: true,
  createdAt: true,
  _count: { select: { orders: true } },
}

function serialize(user, extras = {}) {
  const { _count, ...rest } = user
  return {
    ...rest,
    orderCount: _count?.orders ?? 0,
    creditUsedCents: extras.creditUsedCents ?? 0,
  }
}

function buildUserWhere({ search, status, role }) {
  return {
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
}

function csvEscape(value) {
  const text = String(value ?? '')
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

function formatSignupDate(value) {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ]
  const day = String(date.getUTCDate()).padStart(2, '0')
  const month = months[date.getUTCMonth()]
  const year = date.getUTCFullYear()

  // Word date + leading tab keeps Excel from turning it into a date serial
  // (which shows as ######## when the column is narrow).
  return `\t${month} ${day}, ${year}`
}

/**
 * Mailchimp / Klaviyo / Constant Contact friendly CSV.
 * Members register with company / institution as their display name — not personal first/last.
 */
function buildAudienceCsv(users) {
  const header = [
    'Email Address',
    'Company / Institution Name',
    'Phone',
    'How Did You Hear About Us',
    'Tags',
    'Status',
    'Signup Date',
  ]

  const rows = users.map((user) => {
    const institution =
      String(user.name || '').trim() ||
      String(user.company || '').trim()

    const tags = [
      user.role === 'ADMIN' ? 'Admin' : 'Member',
      user.status === 'ACTIVE' ? 'Active' : user.status === 'PENDING' ? 'Pending' : 'Blocked',
    ].join(', ')

    return [
      user.email,
      institution,
      user.phone || '',
      user.heardAboutUs || '',
      tags,
      user.status,
      formatSignupDate(user.createdAt),
    ]
      .map(csvEscape)
      .join(',')
  })

  // UTF-8 BOM helps Excel open the file correctly.
  return `\uFEFF${[header.join(','), ...rows].join('\r\n')}\r\n`
}

/** Blocks an admin from locking themselves out or deleting their own account. */
function assertNotSelf(req, id, action) {
  if (req.user.id === id) throw badRequest(`You cannot ${action} your own account.`)
}

const router = Router()

router.use(requireAdmin)

router.get('/export', validate(exportQuerySchema, 'query'), async (req, res) => {
  const { search, status, role } = req.validatedQuery
  const where = buildUserWhere({ search, status, role })

  const users = await prisma.user.findMany({
    where,
    select: {
      email: true,
      name: true,
      company: true,
      phone: true,
      heardAboutUs: true,
      role: true,
      status: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
  })

  const stamp = new Date().toISOString().slice(0, 10)
  const csv = buildAudienceCsv(users)

  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="peptide-ops-members-${stamp}.csv"`,
  )
  res.send(csv)
})

router.get('/', validate(listQuerySchema, 'query'), async (req, res) => {
  const { search, status, role, page, perPage } = req.validatedQuery

  const where = buildUserWhere({ search, status, role })

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

  const userIds = users.map((user) => user.id)
  const creditUsage =
    userIds.length === 0
      ? []
      : await prisma.order.groupBy({
          by: ['userId'],
          where: {
            userId: { in: userIds },
            creditCents: { gt: 0 },
            status: { notIn: ['CANCELLED', 'REFUNDED'] },
          },
          _sum: { creditCents: true },
        })
  const usedByUser = new Map(
    creditUsage.map((row) => [row.userId, row._sum.creditCents || 0]),
  )

  res.json({
    users: users.map((user) =>
      serialize(user, { creditUsedCents: usedByUser.get(user.id) || 0 }),
    ),
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
          creditCents: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
      },
    },
  })
  if (!user) throw notFound('Customer not found.')

  const usedAgg = await prisma.order.aggregate({
    where: {
      userId: user.id,
      creditCents: { gt: 0 },
      status: { notIn: ['CANCELLED', 'REFUNDED'] },
    },
    _sum: { creditCents: true },
  })

  res.json({
    user: serialize(user, { creditUsedCents: usedAgg._sum.creditCents || 0 }),
  })
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

router.patch('/:id/credit', validate(creditSchema), async (req, res) => {
  const { id } = req.params
  const creditCents = Math.round(Number(req.body.creditDollars) * 100)

  const existing = await prisma.user.findFirst({ where: { id, deletedAt: null } })
  if (!existing) throw notFound('Customer not found.')

  const user = await prisma.user.update({
    where: { id },
    data: { creditCents },
    select: SELECT,
  })
  invalidateUserCache(id)

  const usedAgg = await prisma.order.aggregate({
    where: {
      userId: id,
      creditCents: { gt: 0 },
      status: { notIn: ['CANCELLED', 'REFUNDED'] },
    },
    _sum: { creditCents: true },
  })

  res.json({
    user: serialize(user, { creditUsedCents: usedAgg._sum.creditCents || 0 }),
  })
})

router.patch('/:id/heard-about', validate(heardAboutSchema), async (req, res) => {
  const { id } = req.params
  const heardAboutUs = String(req.body.heardAboutUs || '').trim() || null

  const existing = await prisma.user.findFirst({ where: { id, deletedAt: null } })
  if (!existing) throw notFound('Customer not found.')

  const user = await prisma.user.update({
    where: { id },
    data: { heardAboutUs },
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
