import fs from 'node:fs'
import { createApp, uploadsDir } from './app.js'
import { env } from './lib/env.js'
import { prisma } from './lib/prisma.js'

fs.mkdirSync(uploadsDir, { recursive: true })

const app = createApp()

// Warm the remote Postgres pool so the first real request is not a cold connect.
prisma.$connect().catch((error) => {
  console.error('[api] Failed to connect to database on boot:', error.message)
})

const server = app.listen(env.port, () => {
  console.log(`[api] Peptide Ops API listening on ${env.apiUrl} (${env.nodeEnv})`)
})

async function shutdown(signal) {
  console.log(`[api] ${signal} received, shutting down.`)
  server.close(async () => {
    await prisma.$disconnect()
    process.exit(0)
  })
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
