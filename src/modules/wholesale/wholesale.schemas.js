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
    sortOrder: z.coerce.number().int().min(0).max(100000).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update.')
