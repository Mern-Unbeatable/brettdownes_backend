import { Router } from 'express'
import { validate } from '../../middleware/validate.js'
import { requireAuth } from '../../middleware/auth.js'
import { rateLimit } from '../../middleware/rate-limit.js'
import * as controller from './auth.controller.js'
import {
  addressSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  registerResendSchema,
  registerSchema,
  registerVerifySchema,
  resetPasswordSchema,
  updateProfileSchema,
} from './auth.schemas.js'

const router = Router()

const credentialLimit = rateLimit({
  windowMs: 15 * 60_000,
  max: 20,
  message: 'Too many attempts. Please wait a few minutes and try again.',
})

const otpLimit = rateLimit({
  windowMs: 15 * 60_000,
  max: 10,
  message: 'Too many verification attempts. Please wait a few minutes and try again.',
})

router.post('/register/start', credentialLimit, validate(registerSchema), controller.registerStart)
router.post(
  '/register/verify',
  otpLimit,
  validate(registerVerifySchema),
  controller.registerVerify,
)
router.post(
  '/register/resend',
  otpLimit,
  validate(registerResendSchema),
  controller.registerResend,
)
// Legacy alias — same as /register/start (OTP required before account creation).
router.post('/register', credentialLimit, validate(registerSchema), controller.registerStart)

router.post('/login', credentialLimit, validate(loginSchema), controller.login)
router.post('/logout', controller.logout)
router.get('/me', controller.me)

router.post(
  '/forgot-password',
  credentialLimit,
  validate(forgotPasswordSchema),
  controller.forgotPassword,
)
router.post(
  '/reset-password',
  credentialLimit,
  validate(resetPasswordSchema),
  controller.resetPassword,
)

router.patch('/me', requireAuth, validate(updateProfileSchema), controller.updateProfile)
router.patch(
  '/me/password',
  requireAuth,
  validate(changePasswordSchema),
  controller.changePassword,
)

router.get('/me/addresses', requireAuth, controller.listAddresses)
router.post('/me/addresses', requireAuth, validate(addressSchema), controller.createAddress)
router.patch('/me/addresses/:id', requireAuth, validate(addressSchema), controller.updateAddress)
router.delete('/me/addresses/:id', requireAuth, controller.deleteAddress)

export default router
