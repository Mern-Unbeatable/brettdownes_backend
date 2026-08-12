import { z } from 'zod'

const email = z.string().trim().toLowerCase().email('Enter a valid email address.')
const password = z.string().min(8, 'Password must be at least 8 characters.').max(200)

export const registerSchema = z.object({
  name: z.string().trim().min(1, 'Your name is required.').max(120).optional(),
  company: z.string().trim().min(1, 'Company or institution is required.').max(160),
  email,
  password,
  phone: z.string().trim().max(40).optional().or(z.literal('')),
  researchFramework: z
    .string()
    .trim()
    .min(1, 'Describe your intended evaluation framework.')
    .max(2000),
})

export const loginSchema = z.object({
  email,
  password: z.string().min(1, 'Enter your password.'),
})

export const forgotPasswordSchema = z.object({ email })

export const resetPasswordSchema = z.object({
  token: z.string().min(10, 'This reset link is invalid.'),
  password,
})

export const updateProfileSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  company: z.string().trim().max(160).optional().or(z.literal('')),
  phone: z.string().trim().max(40).optional().or(z.literal('')),
  researchFramework: z.string().trim().max(2000).optional().or(z.literal('')),
})

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password.'),
  password,
})

export const addressSchema = z.object({
  label: z.string().trim().max(60).optional().or(z.literal('')),
  line1: z.string().trim().min(1, 'Street address is required.').max(200),
  line2: z.string().trim().max(200).optional().or(z.literal('')),
  city: z.string().trim().min(1, 'City is required.').max(120),
  state: z.string().trim().min(1, 'State is required.').max(60),
  zip: z.string().trim().min(3, 'ZIP is required.').max(20),
  country: z.string().trim().length(2).default('US'),
  isDefault: z.boolean().default(false),
})
