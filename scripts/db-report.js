/**
 * Prints row counts and any leftover test accounts.
 * Usage: node scripts/db-report.js
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const testUsers = await prisma.user.findMany({
  where: { OR: [{ email: { startsWith: 'smoke_' } }, { email: { startsWith: 'verify_' } }] },
  select: { id: true, email: true, status: true, _count: { select: { orders: true } } },
})

console.log('\nTest accounts left behind:')
if (testUsers.length === 0) {
  console.log('  none')
} else {
  for (const user of testUsers) {
    console.log(`  ${user.email}  status=${user.status}  orders=${user._count.orders}`)
  }
}

const [users, orders, products, variants, admins] = await Promise.all([
  prisma.user.count({ where: { deletedAt: null } }),
  prisma.order.count(),
  prisma.product.count(),
  prisma.variant.count(),
  prisma.user.count({ where: { role: 'ADMIN', deletedAt: null } }),
])

console.log('\nRow counts:')
console.log(`  users ${users} (admins ${admins})`)
console.log(`  orders ${orders}`)
console.log(`  products ${products} / variants ${variants}\n`)

await prisma.$disconnect()
