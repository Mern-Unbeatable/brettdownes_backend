import { z } from 'zod'

export const unlockSchema = z.object({
  password: z.string().min(1, 'Enter the access password.').max(200),
})

export const changePasswordSchema = z.object({
  currentPassword: z.string().max(200).optional(),
  newPassword: z.string().min(4, 'New password must be at least 4 characters.').max(200),
})

export const categoryCreateSchema = z.object({
  name: z.string().trim().min(1, 'Category name is required.').max(80),
  sortOrder: z.coerce.number().int().min(0).max(100000).optional(),
})

export const categoryUpdateSchema = z
  .object({
    name: z.string().trim().min(1, 'Category name is required.').max(80).optional(),
    sortOrder: z.coerce.number().int().min(0).max(100000).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update.')

export const productCreateSchema = z.object({
  categoryId: z.string().min(1, 'Choose a category.'),
  catNo: z.string().trim().max(80).optional().default(''),
  name: z.string().trim().max(200).optional().default(''),
  strength: z.string().trim().max(120).optional().default(''),
  vialSize: z.string().trim().max(160).optional().default(''),
  price: z.coerce.number().min(0).max(1000000).optional().default(0),
  inStock: z.coerce.boolean().optional(),
  sortOrder: z.coerce.number().int().min(0).max(100000).optional(),
})

export const productUpdateSchema = z
  .object({
    categoryId: z.string().min(1).optional(),
    catNo: z.string().trim().max(80).optional(),
    name: z.string().trim().max(200).optional(),
    strength: z.string().trim().max(120).optional(),
    vialSize: z.string().trim().max(160).optional(),
    price: z.coerce.number().min(0).max(1000000).optional(),
    inStock: z.coerce.boolean().optional(),
    sortOrder: z.coerce.number().int().min(0).max(100000).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update.')

export const configUpdateSchema = z
  .object({
    note: z.string().max(2000).optional(),
    telegramUrl: z.string().trim().max(400).optional().or(z.literal('')),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update.')

const lineItemsSchema = z
  .array(
    z.object({
      id: z.string().min(1),
      qty: z.coerce.number().int().min(1).max(999),
    }),
  )
  .min(1, 'Your order is empty.')

export const couponSchema = z.object({
  items: lineItemsSchema,
  code: z.string().trim().min(1, 'Enter a coupon code.').max(40),
})

/** Live-rate quote request for the private store (guest, no account). */
export const ratesSchema = z.object({
  items: lineItemsSchema,
  address: z.object({
    name: z.string().trim().max(120).optional().or(z.literal('')),
    line1: z.string().trim().min(1, 'Street address is required.').max(200),
    line2: z.string().trim().max(200).optional().or(z.literal('')),
    city: z.string().trim().min(1, 'City is required.').max(120),
    state: z.string().trim().min(1, 'State / province is required.').max(60),
    zip: z.string().trim().min(2, 'ZIP / postal code is required.').max(20),
    country: z.string().trim().length(2).default('US'),
    phone: z.string().trim().max(40).optional().or(z.literal('')),
    email: z.string().trim().toLowerCase().email().optional().or(z.literal('')),
  }),
})

export const checkoutSchema = z.object({
  items: lineItemsSchema,
  // Live carrier rate selected from the API (same flow as the main store).
  shipmentId: z.string().trim().min(1, 'Select a shipping rate.').max(120),
  rateId: z.string().trim().min(1, 'Select a shipping rate.').max(120),
  contact: z.object({
    name: z.string().trim().min(1, 'Full name is required.').max(120),
    email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
    phone: z.string().trim().min(1, 'Phone number is required.').max(40),
  }),
  address: z.object({
    line1: z.string().trim().min(1, 'Address is required.').max(200),
    line2: z.string().trim().max(200).optional().or(z.literal('')),
    city: z.string().trim().min(1, 'City is required.').max(120),
    state: z.string().trim().min(1, 'State is required.').max(60),
    zip: z.string().trim().min(2, 'ZIP / postcode is required.').max(20),
    country: z.string().trim().length(2).default('US'),
  }),
  couponCode: z.string().trim().max(40).optional().or(z.literal('')),
  notes: z.string().trim().max(2000).optional().or(z.literal('')),
})

export const confirmSchema = z.object({
  orderId: z.string().min(1),
  sessionId: z.string().min(1),
})

export const adminOrderListQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  status: z.enum(['PENDING', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED']).optional(),
  paymentStatus: z.enum(['UNPAID', 'PAID', 'REFUNDED']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
})

export const orderStatusSchema = z.object({
  status: z.enum(['PENDING', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED']),
})

export const orderPaymentSchema = z.object({
  paymentStatus: z.enum(['UNPAID', 'PAID', 'REFUNDED']),
})

export const orderTrackingSchema = z.object({
  trackingCode: z.string().trim().min(3, 'Paste a tracking number.').max(80),
  carrier: z.string().trim().max(80).optional().or(z.literal('')),
  trackingUrl: z.string().trim().max(400).optional().or(z.literal('')),
})
