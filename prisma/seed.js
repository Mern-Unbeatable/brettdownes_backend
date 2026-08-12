import bcrypt from 'bcryptjs'
import { PrismaClient } from '@prisma/client'
import { env } from '../src/lib/env.js'
import { toCents } from '../src/lib/money.js'
import { DEFAULT_SETTINGS, SETTINGS_KEY } from '../src/modules/settings/settings.defaults.js'
// The storefront catalogue is the source of truth for the initial import.
import { products } from '../../frontend/src/data/site.js'

const prisma = new PrismaClient()

async function seedAdmin() {
  const email = env.seedAdmin.email.toLowerCase()
  const passwordHash = await bcrypt.hash(env.seedAdmin.password, 12)

  const admin = await prisma.user.upsert({
    where: { email },
    update: { role: 'ADMIN', status: 'ACTIVE', deletedAt: null },
    create: {
      email,
      passwordHash,
      name: env.seedAdmin.name,
      company: 'Peptide Ops Logistics',
      role: 'ADMIN',
      status: 'ACTIVE',
    },
  })

  console.log(`[seed] admin ready: ${admin.email}`)
}

async function seedSettings() {
  const existing = await prisma.setting.findUnique({ where: { key: SETTINGS_KEY } })
  if (existing) {
    console.log('[seed] settings already exist, leaving them untouched')
    return
  }
  await prisma.setting.create({
    data: { key: SETTINGS_KEY, value: DEFAULT_SETTINGS },
  })
  console.log('[seed] default settings created')
}

async function seedProducts() {
  for (const [index, product] of products.entries()) {
    const record = await prisma.product.upsert({
      where: { slug: product.slug },
      update: {},
      create: {
        slug: product.slug,
        name: product.name,
        category: product.category,
        summary: product.summary ?? '',
        description: product.description ?? '',
        purity: product.purity ?? '',
        form: product.form ?? 'Lyophilized',
        image: product.image ?? '',
        highlights: product.highlights ?? [],
        sortOrder: index,
        isActive: true,
      },
    })

    for (const [variantIndex, variant] of product.variants.entries()) {
      await prisma.variant.upsert({
        where: { sku: variant.sku },
        update: {},
        create: {
          productId: record.id,
          dose: variant.dose,
          priceCents: toCents(variant.price),
          sku: variant.sku,
          image: variant.image ?? product.image ?? '',
          stock: 25,
          sortOrder: variantIndex,
        },
      })
    }
  }

  const count = await prisma.product.count()
  console.log(`[seed] ${count} products in catalogue`)
}

async function main() {
  await seedSettings()
  await seedAdmin()
  await seedProducts()
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error('[seed] failed:', error)
    await prisma.$disconnect()
    process.exit(1)
  })
