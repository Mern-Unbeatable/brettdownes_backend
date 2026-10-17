import bcrypt from 'bcryptjs'
import { PrismaClient } from '@prisma/client'
import { toCents } from '../src/lib/money.js'
import { WHOLESALE_CATEGORIES } from './wholesale-data.js'

const prisma = new PrismaClient()
const WHOLESALE_SETTINGS_KEY = 'wholesale'
const DEFAULT_WHOLESALE_PASSWORD = 'wholesale2026'

function slugify(value) {
  return (
    String(value || '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'category'
  )
}

async function seedAccessPassword() {
  const existing = await prisma.setting.findUnique({ where: { key: WHOLESALE_SETTINGS_KEY } })
  if (existing?.value?.accessPasswordHash) {
    console.log('[wholesale] access password already set, leaving it untouched')
    return
  }
  const hash = await bcrypt.hash(DEFAULT_WHOLESALE_PASSWORD, 12)
  await prisma.setting.upsert({
    where: { key: WHOLESALE_SETTINGS_KEY },
    update: { value: { ...(existing?.value || {}), accessPasswordHash: hash } },
    create: { key: WHOLESALE_SETTINGS_KEY, value: { accessPasswordHash: hash } },
  })
  console.log(`[wholesale] access password set to default "${DEFAULT_WHOLESALE_PASSWORD}"`)
}

async function seedCatalog() {
  for (const [catIndex, category] of WHOLESALE_CATEGORIES.entries()) {
    const slug = slugify(category.name)
    const record = await prisma.wholesaleCategory.upsert({
      where: { slug },
      update: { name: category.name, sortOrder: catIndex },
      create: { name: category.name, slug, sortOrder: catIndex },
    })

    const existingCount = await prisma.wholesaleProduct.count({
      where: { categoryId: record.id },
    })
    if (existingCount > 0) {
      console.log(
        `[wholesale] "${category.name}" already has ${existingCount} products, skipping import`,
      )
      continue
    }

    await prisma.wholesaleProduct.createMany({
      data: category.products.map((product, index) => ({
        categoryId: record.id,
        catNo: product.catNo || '',
        name: product.name || '',
        strength: product.strength || '',
        vialSize: product.vialSize || '',
        priceCents: toCents(product.price),
        sortOrder: index,
      })),
    })
    console.log(`[wholesale] imported ${category.products.length} products into "${category.name}"`)
  }
}

/** Ensures the three storefront tabs exist: Oils / Tabs / Other. */
async function seedOtherCategory() {
  const slug = 'other'
  const existing = await prisma.wholesaleCategory.findUnique({ where: { slug } })
  if (existing) {
    console.log('[wholesale] "Other" category already exists')
    return
  }
  const count = await prisma.wholesaleCategory.count()
  await prisma.wholesaleCategory.create({
    data: { name: 'Other', slug, sortOrder: count },
  })
  console.log('[wholesale] created empty "Other" category')
}

async function main() {
  await seedAccessPassword()
  await seedCatalog()
  await seedOtherCategory()
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error('[wholesale] seed failed:', error)
    await prisma.$disconnect()
    process.exit(1)
  })
