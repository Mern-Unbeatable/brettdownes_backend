import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound } from '../../lib/http-error.js'
import { requireAdmin, requireAuth, invalidateUserCache } from '../../middleware/auth.js'
import { validate } from '../../middleware/validate.js'
import { rateLimit } from '../../middleware/rate-limit.js'
import { sendMail } from '../../lib/mailer.js'
import { templates } from '../../lib/email-templates.js'
import { createSignupOtp, hashSignupOtp } from '../../lib/tokens.js'

const REWARD_CENTS = 500
const OTP_TTL_MS = 1000 * 60 * 10
const OTP_MAX_ATTEMPTS = 5
const TRUSTPILOT_URL = 'https://www.trustpilot.com/review/peptideopslogistics.com'

const otpSchema = z.object({
  orderId: z.string().uuid(),
  reviewEmail: z.string().trim().toLowerCase().email('Enter a valid email address.'),
})

const verifySchema = z.object({
  orderId: z.string().uuid(),
  otp: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code.'),
})

const rejectSchema = z.object({
  reason: z.string().trim().max(400).optional().or(z.literal('')),
})

const listQuerySchema = z.object({
  status: z.enum(['AWAITING_OTP', 'PENDING', 'APPROVED', 'REJECTED']).optional(),
  search: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(50).default(10),
})

const mineQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  orderId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(50).default(8),
})

const otpThrottle = rateLimit({
  windowMs: 60_000,
  max: 8,
  message: 'Too many codes. Wait a minute and try again.',
})

function publicClaim(claim) {
  if (!claim) return null
  return {
    id: claim.id,
    status: claim.status,
    reviewEmail: claim.reviewEmail,
    emailVerifiedAt: claim.emailVerifiedAt,
    creditCents: claim.creditCents,
    rejectReason: claim.rejectReason,
    reviewedAt: claim.reviewedAt,
    createdAt: claim.createdAt,
  }
}

async function ownedDeliveredOrder(userId, orderId) {
  const order = await prisma.order.findFirst({
    where: {
      id: orderId,
      userId,
      status: 'DELIVERED',
      paymentStatus: 'PAID',
    },
    select: { id: true, orderNumber: true, userId: true },
  })
  if (!order) throw notFound('That delivered order was not found on your account.')
  return order
}

const userRouter = Router()
userRouter.use(requireAuth)

userRouter.get('/mine', validate(mineQuerySchema, 'query'), async (req, res) => {
  const { search, page, perPage } = req.validatedQuery
  const where = {
    userId: req.user.id,
    status: 'DELIVERED',
    paymentStatus: 'PAID',
    ...(search
      ? { orderNumber: { contains: search, mode: 'insensitive' } }
      : {}),
  }

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      select: {
        id: true,
        orderNumber: true,
        status: true,
        totalCents: true,
        createdAt: true,
        updatedAt: true,
        reviewClaim: true,
      },
      orderBy: { updatedAt: 'desc' },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    prisma.order.count({ where }),
  ])

  res.json({
    rewardCents: REWARD_CENTS,
    trustpilotUrl: TRUSTPILOT_URL,
    total,
    page,
    perPage,
    pages: Math.max(1, Math.ceil(total / perPage)),
    orders: orders.map((order) => ({
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      totalCents: order.totalCents,
      deliveredAt: order.updatedAt,
      createdAt: order.createdAt,
      claim: publicClaim(order.reviewClaim),
    })),
  })
})

userRouter.post('/otp', otpThrottle, validate(otpSchema), async (req, res) => {
  const { orderId, reviewEmail } = req.body
  const order = await ownedDeliveredOrder(req.user.id, orderId)
  const existing = await prisma.reviewCreditClaim.findUnique({ where: { orderId } })

  if (existing?.status === 'APPROVED') {
    throw badRequest('This order already received review credit.')
  }
  if (existing?.status === 'PENDING') {
    throw badRequest('This review is already waiting for approval.')
  }

  const { raw, hash } = createSignupOtp()
  const expiresAt = new Date(Date.now() + OTP_TTL_MS)
  const data = {
    userId: req.user.id,
    orderNumber: order.orderNumber,
    reviewEmail,
    otpHash: hash,
    otpExpiresAt: expiresAt,
    otpAttempts: 0,
    emailVerifiedAt: null,
    status: 'AWAITING_OTP',
    rejectReason: null,
    reviewedAt: null,
    creditCents: REWARD_CENTS,
  }

  const claim = existing
    ? await prisma.reviewCreditClaim.update({ where: { orderId }, data })
    : await prisma.reviewCreditClaim.create({ data: { ...data, orderId } })

  const delivery = await sendMail({
    to: reviewEmail,
    ...templates.reviewOtp({ name: req.user.name || 'there', code: raw }),
  })
  if (!delivery.sent && delivery.reason !== 'smtp-not-configured') {
    throw badRequest('Could not send the verification code. Try again shortly.')
  }

  res.json({
    ok: true,
    claim: publicClaim(claim),
    message: 'Check that inbox for a 6-digit code.',
  })
})

userRouter.post('/verify', otpThrottle, validate(verifySchema), async (req, res) => {
  const { orderId, otp } = req.body
  await ownedDeliveredOrder(req.user.id, orderId)

  const claim = await prisma.reviewCreditClaim.findUnique({ where: { orderId } })
  if (!claim || claim.userId !== req.user.id) {
    throw badRequest('Request a verification code first.')
  }
  if (claim.status === 'APPROVED') throw badRequest('This order already received review credit.')
  if (claim.status === 'PENDING') throw badRequest('This review is already waiting for approval.')
  if (!claim.otpExpiresAt || claim.otpExpiresAt < new Date()) {
    throw badRequest('This code has expired. Request a new one.')
  }
  if (claim.otpAttempts >= OTP_MAX_ATTEMPTS) {
    throw badRequest('Too many incorrect codes. Request a new one.')
  }
  if (hashSignupOtp(otp) !== claim.otpHash) {
    await prisma.reviewCreditClaim.update({
      where: { id: claim.id },
      data: { otpAttempts: { increment: 1 } },
    })
    throw badRequest('Incorrect verification code.')
  }

  const updated = await prisma.reviewCreditClaim.update({
    where: { id: claim.id },
    data: {
      status: 'PENDING',
      emailVerifiedAt: new Date(),
      otpHash: null,
      otpExpiresAt: null,
      otpAttempts: 0,
    },
  })

  res.json({
    ok: true,
    claim: publicClaim(updated),
    message: 'Email verified. We will check the review and add credit if it is approved.',
  })
})

const adminRouter = Router()
adminRouter.use(requireAdmin)

adminRouter.get('/count', async (req, res) => {
  const pending = await prisma.reviewCreditClaim.count({ where: { status: 'PENDING' } })
  res.json({ pending })
})

adminRouter.get('/', validate(listQuerySchema, 'query'), async (req, res) => {
  const { status, search, page, perPage } = req.validatedQuery
  const term = search || ''
  const where = {
    ...(status ? { status } : { status: { in: ['PENDING', 'APPROVED', 'REJECTED'] } }),
    ...(term
      ? {
          OR: [
            { orderNumber: { contains: term, mode: 'insensitive' } },
            { reviewEmail: { contains: term, mode: 'insensitive' } },
            { user: { name: { contains: term, mode: 'insensitive' } } },
            { user: { email: { contains: term, mode: 'insensitive' } } },
          ],
        }
      : {}),
  }

  const [claims, total, pending] = await Promise.all([
    prisma.reviewCreditClaim.findMany({
      where,
      include: {
        user: { select: { id: true, name: true, email: true, creditCents: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    prisma.reviewCreditClaim.count({ where }),
    prisma.reviewCreditClaim.count({ where: { status: 'PENDING' } }),
  ])

  res.json({
    pending,
    rewardCents: REWARD_CENTS,
    trustpilotUrl: TRUSTPILOT_URL,
    total,
    page,
    perPage,
    pages: Math.max(1, Math.ceil(total / perPage)),
    claims: claims.map((claim) => ({
      ...publicClaim(claim),
      orderId: claim.orderId,
      orderNumber: claim.orderNumber,
      user: claim.user,
    })),
  })
})

adminRouter.post('/:id/approve', async (req, res) => {
  const claim = await prisma.reviewCreditClaim.findUnique({
    where: { id: req.params.id },
    include: { user: { select: { id: true, name: true, email: true, creditCents: true, deletedAt: true } } },
  })
  if (!claim) throw notFound('Review request not found.')
  if (claim.status !== 'PENDING') throw badRequest('Only verified requests waiting for review can be approved.')
  if (!claim.user || claim.user.deletedAt) throw badRequest('That customer account is no longer active.')

  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.reviewCreditClaim.update({
      where: { id: claim.id },
      data: {
        status: 'APPROVED',
        creditCents: REWARD_CENTS,
        reviewedAt: new Date(),
        rejectReason: null,
      },
    })
    const user = await tx.user.update({
      where: { id: claim.userId },
      data: { creditCents: { increment: REWARD_CENTS } },
      select: { id: true, name: true, email: true, creditCents: true },
    })
    return { updated, user }
  })

  invalidateUserCache(claim.userId)
  const addedCents = REWARD_CENTS
  if (result.user.email) {
    sendMail({
      to: result.user.email,
      ...templates.reviewCreditAdded({
        name: result.user.name || 'there',
        addedCents,
        balanceCents: result.user.creditCents,
        orderNumber: claim.orderNumber,
      }),
    })
  }

  res.json({
    claim: {
      ...publicClaim(result.updated),
      orderId: result.updated.orderId,
      orderNumber: result.updated.orderNumber,
      user: result.user,
    },
  })
})

adminRouter.post('/:id/reject', validate(rejectSchema), async (req, res) => {
  const claim = await prisma.reviewCreditClaim.findUnique({ where: { id: req.params.id } })
  if (!claim) throw notFound('Review request not found.')
  if (claim.status !== 'PENDING') throw badRequest('Only requests waiting for review can be rejected.')

  const updated = await prisma.reviewCreditClaim.update({
    where: { id: claim.id },
    data: {
      status: 'REJECTED',
      reviewedAt: new Date(),
      rejectReason: String(req.body.reason || '').trim() || 'Review could not be verified.',
    },
    include: { user: { select: { id: true, name: true, email: true, creditCents: true } } },
  })

  res.json({
    claim: {
      ...publicClaim(updated),
      orderId: updated.orderId,
      orderNumber: updated.orderNumber,
      user: updated.user,
    },
  })
})

export { userRouter, adminRouter }
