import bcrypt from 'bcryptjs'
import { prisma } from '../../lib/prisma.js'
import { env } from '../../lib/env.js'
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../../lib/http-error.js'
import {
  clearSessionCookie,
  createResetToken,
  hashResetToken,
  setSessionCookie,
  signSessionToken,
} from '../../lib/tokens.js'
import { sendMail } from '../../lib/mailer.js'
import { templates } from '../../lib/email-templates.js'
import { invalidateUserCache, PUBLIC_USER_FIELDS } from '../../middleware/auth.js'
import { getAdminRecipients, getSettings } from '../settings/settings.service.js'

const RESET_TTL_MS = 1000 * 60 * 30

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    company: user.company,
    phone: user.phone,
    researchFramework: user.researchFramework,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
  }
}

export async function register(req, res) {
  const { email, password, company, phone, researchFramework } = req.body
  const name = req.body.name?.trim() || company

  const existing = await prisma.user.findUnique({ where: { email } })
  if (existing) {
    throw conflict('An account with that email already exists. Try signing in instead.')
  }

  const settings = await getSettings()
  const passwordHash = await bcrypt.hash(password, 12)

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      name,
      company,
      phone: phone || null,
      researchFramework,
      role: 'USER',
      status: settings.autoApproval ? 'ACTIVE' : 'PENDING',
    },
  })

  if (settings.notifyNewRegistration) {
    const recipients = await getAdminRecipients(settings)
    const mail = templates.adminNewRegistration(user)
    sendMail({ to: recipients, ...mail })
  }

  const welcome = settings.autoApproval
    ? templates.registrationApproved(user)
    : templates.registrationPending(user)
  sendMail({ to: user.email, ...welcome })

  // Auto-approved accounts are signed in immediately; pending ones are not.
  if (user.status === 'ACTIVE') {
    setSessionCookie(res, signSessionToken(user))
    return res.status(201).json({ user: publicUser(user), autoApproved: true })
  }

  res.status(201).json({
    user: publicUser(user),
    autoApproved: false,
    message: 'Registration received. We will email you as soon as your access is approved.',
  })
}

export async function login(req, res) {
  const { email, password } = req.body

  const user = await prisma.user.findFirst({ where: { email, deletedAt: null } })
  // Same message for unknown email and wrong password so accounts cannot be enumerated.
  if (!user) throw unauthorized('Invalid email or password.')

  const valid = await bcrypt.compare(password, user.passwordHash)
  if (!valid) throw unauthorized('Invalid email or password.')

  if (user.status === 'PENDING') {
    throw forbidden('Your account is awaiting approval. We will email you once it is verified.')
  }
  if (user.status === 'BLOCKED') {
    throw forbidden('This account has been suspended. Contact support for assistance.')
  }

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })

  setSessionCookie(res, signSessionToken(user))
  res.json({ user: publicUser(user) })
}

export async function logout(req, res) {
  clearSessionCookie(res)
  res.json({ ok: true })
}

export async function me(req, res) {
  if (!req.user) return res.json({ user: null })
  res.json({ user: req.user })
}

export async function updateProfile(req, res) {
  const data = {}
  for (const field of ['name', 'company', 'phone', 'researchFramework']) {
    if (req.body[field] !== undefined) data[field] = req.body[field] || null
  }
  if (!data.name && req.body.name === '') throw badRequest('Name cannot be empty.')

  const user = await prisma.user.update({
    where: { id: req.user.id },
    data,
    select: PUBLIC_USER_FIELDS,
  })
  invalidateUserCache(user.id)
  res.json({ user })
}

export async function changePassword(req, res) {
  const { currentPassword, password } = req.body

  const user = await prisma.user.findUnique({ where: { id: req.user.id } })
  if (!user) throw notFound('Account not found.')

  const valid = await bcrypt.compare(currentPassword, user.passwordHash)
  if (!valid) throw badRequest('Your current password is incorrect.')

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await bcrypt.hash(password, 12) },
  })
  invalidateUserCache(user.id)

  res.json({ ok: true })
}

export async function forgotPassword(req, res) {
  const { email } = req.body
  const user = await prisma.user.findFirst({ where: { email, deletedAt: null } })

  // Always report success so this endpoint cannot be used to probe for accounts.
  if (user) {
    const { raw, hash } = createResetToken()
    await prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash: hash, expiresAt: new Date(Date.now() + RESET_TTL_MS) },
    })
    const resetUrl = `${env.clientUrl}/reset-password?token=${raw}`
    const mail = templates.passwordReset(user, resetUrl)
    sendMail({ to: user.email, ...mail })
  }

  res.json({ ok: true, message: 'If an account exists, a reset link is on its way.' })
}

export async function resetPassword(req, res) {
  const { token, password } = req.body
  const tokenHash = hashResetToken(token)

  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  })

  if (!record || record.usedAt || record.expiresAt < new Date()) {
    throw badRequest('This reset link is invalid or has expired. Request a new one.')
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: record.userId },
      data: { passwordHash: await bcrypt.hash(password, 12) },
    }),
    prisma.passwordResetToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    }),
  ])

  res.json({ ok: true })
}

export async function listAddresses(req, res) {
  const addresses = await prisma.address.findMany({
    where: { userId: req.user.id },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
  })
  res.json({ addresses })
}

export async function createAddress(req, res) {
  const { isDefault, ...rest } = req.body

  const address = await prisma.$transaction(async (tx) => {
    if (isDefault) {
      await tx.address.updateMany({ where: { userId: req.user.id }, data: { isDefault: false } })
    }
    const count = await tx.address.count({ where: { userId: req.user.id } })
    return tx.address.create({
      data: { ...rest, isDefault: isDefault || count === 0, userId: req.user.id },
    })
  })

  res.status(201).json({ address })
}

export async function updateAddress(req, res) {
  const { id } = req.params
  const owned = await prisma.address.findFirst({ where: { id, userId: req.user.id } })
  if (!owned) throw notFound('Address not found.')

  const { isDefault, ...rest } = req.body

  const address = await prisma.$transaction(async (tx) => {
    if (isDefault) {
      await tx.address.updateMany({ where: { userId: req.user.id }, data: { isDefault: false } })
    }
    return tx.address.update({ where: { id }, data: { ...rest, isDefault: Boolean(isDefault) } })
  })

  res.json({ address })
}

export async function deleteAddress(req, res) {
  const { id } = req.params
  const owned = await prisma.address.findFirst({ where: { id, userId: req.user.id } })
  if (!owned) throw notFound('Address not found.')

  await prisma.address.delete({ where: { id } })
  res.json({ ok: true })
}
