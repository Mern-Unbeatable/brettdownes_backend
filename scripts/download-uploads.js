/**
 * Download uploaded files referenced in the database.
 *
 * Images and documents both live in backend/uploads/ on the server.
 * They are served at {API_URL}/uploads/{filename} — there is no public folder listing.
 *
 * Usage (from backend/):
 *   node scripts/download-uploads.js
 *   node scripts/download-uploads.js --api https://api.peptideopslogistics.com
 *   node scripts/download-uploads.js --out ./downloads
 *
 * Requires DATABASE_URL (and optionally API_URL) in .env or the environment.
 */
import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '@prisma/client'

const here = path.dirname(fileURLToPath(import.meta.url))
const backendRoot = path.resolve(here, '..')

function parseArgs(argv) {
  const args = { api: process.env.API_URL || 'http://localhost:4000', out: path.join(backendRoot, 'uploads') }
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--api' && argv[i + 1]) {
      args.api = argv[++i].replace(/\/$/, '')
    } else if (arg === '--out' && argv[i + 1]) {
      args.out = path.resolve(argv[++i])
    } else if (arg === '--help' || arg === '-h') {
      args.help = true
    }
  }
  return args
}

function walkStrings(value, hits = []) {
  if (typeof value === 'string') {
    hits.push(value)
    return hits
  }
  if (Array.isArray(value)) {
    for (const entry of value) walkStrings(entry, hits)
    return hits
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) walkStrings(entry, hits)
  }
  return hits
}

function toUploadPath(value) {
  if (!value || typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null

  if (trimmed.startsWith('/uploads/')) return trimmed
  try {
    const url = new URL(trimmed)
    const match = url.pathname.match(/^\/uploads\/[^/]+$/)
    return match ? match[0] : null
  } catch {
    return null
  }
}


async function collectUploadPaths(prisma) {
  const paths = new Set()

  const [products, variants, coaDocs, orderItems, settingsRows] = await Promise.all([
    prisma.product.findMany({ select: { image: true } }),
    prisma.variant.findMany({ select: { image: true } }),
    prisma.coaDocument.findMany({ select: { documentUrl: true } }),
    prisma.orderItem.findMany({ select: { image: true } }),
    prisma.setting.findMany({ select: { value: true } }),
  ])

  for (const row of products) {
    const p = toUploadPath(row.image)
    if (p) paths.add(p)
  }
  for (const row of variants) {
    const p = toUploadPath(row.image)
    if (p) paths.add(p)
  }
  for (const row of coaDocs) {
    const p = toUploadPath(row.documentUrl)
    if (p) paths.add(p)
  }
  for (const row of orderItems) {
    const p = toUploadPath(row.image)
    if (p) paths.add(p)
  }
  for (const row of settingsRows) {
    for (const str of walkStrings(row.value)) {
      const p = toUploadPath(str)
      if (p) paths.add(p)
    }
  }

  return [...paths].sort()
}

async function downloadOne(apiBase, uploadPath, outRoot) {
  const url = `${apiBase}${uploadPath}`
  const filename = path.basename(uploadPath)
  const destPath = path.join(outRoot, filename)

  fs.mkdirSync(outRoot, { recursive: true })
  if (fs.existsSync(destPath)) {
    return { uploadPath, destPath, status: 'skipped' }
  }

  const res = await fetch(url)
  if (!res.ok) {
    return { uploadPath, destPath, status: 'missing', code: res.status }
  }

  const buffer = Buffer.from(await res.arrayBuffer())
  fs.writeFileSync(destPath, buffer)
  return { uploadPath, destPath, status: 'saved', bytes: buffer.length }
}

async function main() {
  const args = parseArgs(process.argv)
  if (args.help) {
    console.log(`Usage: node scripts/download-uploads.js [--api URL] [--out DIR]

  --api   Base API URL (default: API_URL env or http://localhost:4000)
  --out   Output folder (default: backend/uploads)
`)
    return
  }

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Add it to backend/.env first.')
    process.exit(1)
  }

  const prisma = new PrismaClient()
  try {
    const uploadPaths = await collectUploadPaths(prisma)
    console.log(`\nFound ${uploadPaths.length} unique /uploads/ paths in the database.`)
    console.log(`API: ${args.api}`)
    console.log(`Out: ${args.out}\n`)

    if (uploadPaths.length === 0) {
      console.log('Nothing to download.')
      return
    }

    let saved = 0
    let skipped = 0
    let missing = 0

    for (const uploadPath of uploadPaths) {
      const result = await downloadOne(args.api, uploadPath, args.out)
      if (result.status === 'saved') {
        saved += 1
        console.log(`  saved   ${uploadPath} (${result.bytes} bytes)`)
      } else if (result.status === 'skipped') {
        skipped += 1
        console.log(`  skipped ${uploadPath}`)
      } else {
        missing += 1
        console.log(`  missing ${uploadPath} (HTTP ${result.code})`)
      }
    }

    console.log(`\nDone: ${saved} saved, ${skipped} skipped, ${missing} missing.`)
    console.log(`Files are in:\n  ${args.out}\n  (images and PDFs saved flat, same as the live server)\n`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
