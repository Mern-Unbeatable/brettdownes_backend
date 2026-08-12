import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Router } from 'express'
import multer from 'multer'
import { env } from '../../lib/env.js'
import { badRequest } from '../../lib/http-error.js'
import { requireAdmin } from '../../middleware/auth.js'
import { uploadsDir } from '../../app.js'

const ALLOWED = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/avif', '.avif'],
  ['image/gif', '.gif'],
])

const storage = multer.diskStorage({
  destination(req, file, cb) {
    fs.mkdirSync(uploadsDir, { recursive: true })
    cb(null, uploadsDir)
  },
  filename(req, file, cb) {
    // Never trust the client filename; derive the extension from the mime type.
    const ext = ALLOWED.get(file.mimetype) || '.bin'
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`)
  },
})

const upload = multer({
  storage,
  limits: { fileSize: env.maxUploadBytes, files: 1 },
  fileFilter(req, file, cb) {
    if (!ALLOWED.has(file.mimetype)) {
      return cb(badRequest('Only JPG, PNG, WEBP, AVIF or GIF images are allowed.'))
    }
    cb(null, true)
  },
})

const router = Router()

router.post('/', requireAdmin, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(badRequest(`Image must be smaller than ${env.maxUploadBytes / 1024 / 1024}MB.`))
      }
      return next(err)
    }
    if (!req.file) return next(badRequest('No image was uploaded.'))

    const relative = `/uploads/${path.basename(req.file.filename)}`
    res.status(201).json({ url: relative, absoluteUrl: `${env.apiUrl}${relative}` })
  })
})

export default router
