import { z } from 'zod'

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, 'Slug is required.')
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug may only contain lowercase letters, numbers and dashes.')

export const variantInputSchema = z.object({
  dose: z.string().trim().min(1, 'Dose is required.').max(60),
  price: z.coerce.number().min(0, 'Price cannot be negative.').max(1_000_000),
  // Optional — the API auto-generates a unique internal SKU when omitted.
  sku: z.string().trim().max(60).optional(),
  image: z.string().trim().max(500).default(''),
  stock: z.coerce.number().int().min(0).default(0),
  weightOz: z.coerce.number().min(0.1, 'Weight must be at least 0.1 oz.').max(1120).default(2),
  lengthIn: z.coerce.number().min(1).max(108).default(6),
  widthIn: z.coerce.number().min(1).max(108).default(4),
  heightIn: z.coerce.number().min(1).max(108).default(2),
  isActive: z.boolean().default(true),
  sortOrder: z.coerce.number().int().min(0).default(0),
})

export const variantUpdateSchema = variantInputSchema.partial()

export const productCreateSchema = z.object({
  name: z.string().trim().min(1, 'Product name is required.').max(160),
  slug: slug.optional(),
  category: z.string().trim().min(1).max(80).default('Peptides'),
  summary: z.string().trim().max(600).default(''),
  description: z.string().trim().max(6000).default(''),
  purity: z.string().trim().max(60).default(''),
  form: z.string().trim().max(60).default('Lyophilized'),
  image: z.string().trim().max(500).default(''),
  highlights: z.array(z.string().trim().max(200)).max(12).default([]),
  badge: z.string().trim().max(24).default(''),
  showOnHome: z.boolean().default(false),
  homeOrder: z.coerce.number().int().min(0).max(3).default(0),
  isActive: z.boolean().default(true),
  sortOrder: z.coerce.number().int().min(0).default(0),
  variants: z.array(variantInputSchema).min(1, 'Add at least one variant.'),
})

export const productUpdateSchema = productCreateSchema
  .omit({ variants: true })
  .partial()
  .extend({ slug: slug.optional() })

export const productQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  category: z.string().trim().max(80).optional(),
  includeInactive: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .transform((value) => value === true || value === 'true')
    .optional(),
})
