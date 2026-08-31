/**
 * Push every file in backend/uploads/ to a live (or remote) API,
 * keeping the same filenames so DB /uploads/... paths keep working.
 *
 * Usage (from backend/):
 *   node scripts/push-uploads.js
 *   node scripts/push-uploads.js --api https://apibrett.maktechgroup.tech
 *   node scripts/push-uploads.js --api https://apibrett.maktechgroup.tech --dir ./uploads
 *   node scripts/push-uploads.js --email admin@peptideops.com --password '...'
 *
 * Auth: admin login. Defaults to SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD from .env.
 */
import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { File } from 'node:buffer'

const here = path.dirname(fileURLToPath(import.meta.url))
const backendRoot = path.resolve(here, '..')

const MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
}

const BATCH_SIZE = 20

function parseArgs(argv) {
  const args = {
    api: (process.env.API_URL || 'http://localhost:4000').replace(/\/$/, ''),
    dir: path.join(backendRoot, 'uploads'),
    email: process.env.SEED_ADMIN_EMAIL || 'admin@peptideops.com',
    password: process.env.SEED_ADMIN_PASSWORD || '',
  }
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--api' && argv[i + 1]) args.api = argv[++i].replace(/\/$/, '')
    else if (arg === '--dir' && argv[i + 1]) args.dir = path.resolve(argv[++i])
    else if (arg === '--email' && argv[i + 1]) args.email = argv[++i]
    else if (arg === '--password' && argv[i + 1]) args.password = argv[++i]
    else if (arg === '--help' || arg === '-h') args.help = true
  }
  return args
}

function listUploadFiles(dir) {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => {
      const ext = path.extname(name).toLowerCase()
      return Boolean(MIME[ext]) && !name.startsWith('.')
    })
    .sort()
}

async function login(api, email, password) {
  const res = await fetch(`${api}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok || !json.token) {
    throw new Error(`Admin login failed (${res.status}): ${json.message || json.error || 'no token'}`)
  }
  if (json.user?.role !== 'ADMIN') {
    throw new Error(`Logged in as ${json.user?.email || email}, but role is ${json.user?.role}, not ADMIN.`)
  }
  return json.token
}

async function uploadBatch(api, token, dir, names) {
  const form = new FormData()
  for (const name of names) {
    const full = path.join(dir, name)
    const buffer = fs.readFileSync(full)
    const ext = path.extname(name).toLowerCase()
    const type = MIME[ext] || 'application/octet-stream'
    form.append('files', new File([buffer], name, { type }))
  }

  const res = await fetch(`${api}/api/uploads/bulk`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  })

  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = { raw: text.slice(0, 300) }
  }

  if (!res.ok) {
    throw new Error(`Bulk upload failed (${res.status}): ${json.message || json.error || text.slice(0, 200)}`)
  }
  return json
}

async function main() {
  const args = parseArgs(process.argv)
  if (args.help) {
    console.log(`Usage: node scripts/push-uploads.js [--api URL] [--dir DIR] [--email EMAIL] [--password PASS]

  --api       Live API base (default: API_URL or http://localhost:4000)
  --dir       Local folder to push (default: backend/uploads)
  --email     Admin email (default: SEED_ADMIN_EMAIL)
  --password  Admin password (default: SEED_ADMIN_PASSWORD)
`)
    return
  }

  if (!args.password) {
    console.error('Admin password required. Set SEED_ADMIN_PASSWORD in .env or pass --password.')
    process.exit(1)
  }

  const files = listUploadFiles(args.dir)
  console.log(`\nPushing uploads to live (same filenames)\n`)
  console.log(`API:   ${args.api}`)
  console.log(`Dir:   ${args.dir}`)
  console.log(`Files: ${files.length}`)
  console.log(`User:  ${args.email}\n`)

  if (!files.length) {
    console.log('No image/PDF files found to push.')
    return
  }

  const token = await login(args.api, args.email, args.password)
  console.log('Logged in as admin.\n')

  let uploaded = 0
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE)
    const result = await uploadBatch(args.api, token, args.dir, batch)
    uploaded += result.count || batch.length
    for (const name of batch) {
      console.log(`  ok  /uploads/${name}`)
    }
    console.log(`  … batch ${Math.floor(i / BATCH_SIZE) + 1} done (${uploaded}/${files.length})\n`)
  }

  console.log(`Done: ${uploaded} files pushed to ${args.api}/uploads/ (names unchanged).\n`)
}

main().catch((err) => {
  console.error(err.message || err)
  process.exit(1)
})
