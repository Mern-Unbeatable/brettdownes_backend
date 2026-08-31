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
  ['application/pdf', '.pdf'],
])

const SAFE_NAME = /^[a-zA-Z0-9._-]+$/

/** Keep the client basename if safe; otherwise derive a unique name from mime. */
function preserveOrGenerateName(originalName, mimetype) {
  const base = path.basename(String(originalName || '')).replace(/\\/g, '/')
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '')
  if (cleaned && SAFE_NAME.test(cleaned) && cleaned.includes('.')) {
    return cleaned
  }
  const ext = ALLOWED.get(mimetype) || '.bin'
  return `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`
}

const randomStorage = multer.diskStorage({
  destination(req, file, cb) {
    fs.mkdirSync(uploadsDir, { recursive: true })
    cb(null, uploadsDir)
  },
  filename(req, file, cb) {
    // Never trust the client filename for normal product uploads.
    const ext = ALLOWED.get(file.mimetype) || '.bin'
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`)
  },
})

const preserveStorage = multer.diskStorage({
  destination(req, file, cb) {
    fs.mkdirSync(uploadsDir, { recursive: true })
    cb(null, uploadsDir)
  },
  filename(req, file, cb) {
    // Bulk sync must keep the same name so DB /uploads/... URLs still resolve.
    cb(null, preserveOrGenerateName(file.originalname, file.mimetype))
  },
})

const upload = multer({
  storage: randomStorage,
  limits: { fileSize: env.maxUploadBytes, files: 1 },
  fileFilter(req, file, cb) {
    if (!file.mimetype.startsWith('image/') || !ALLOWED.has(file.mimetype)) {
      return cb(badRequest('Only JPG, PNG, WEBP, AVIF or GIF images are allowed.'))
    }
    cb(null, true)
  },
})

const documentUpload = multer({
  storage: randomStorage,
  limits: { fileSize: env.maxUploadBytes, files: 1 },
  fileFilter(req, file, cb) {
    if (!ALLOWED.has(file.mimetype)) {
      return cb(badRequest('Upload a PDF or an image (JPG, PNG, WEBP, AVIF, GIF).'))
    }
    cb(null, true)
  },
})

const bulkUpload = multer({
  storage: preserveStorage,
  limits: { fileSize: env.maxUploadBytes, files: 100 },
  fileFilter(req, file, cb) {
    if (!ALLOWED.has(file.mimetype)) {
      return cb(badRequest(`Unsupported type for ${file.originalname}. Use JPG, PNG, WEBP, AVIF, GIF, or PDF.`))
    }
    cb(null, true)
  },
})

const router = Router()

function filePayload(file) {
  const relative = `/uploads/${path.basename(file.filename)}`
  return {
    name: path.basename(file.filename),
    url: relative,
    absoluteUrl: `${env.apiUrl}${relative}`,
    size: file.size,
    mimetype: file.mimetype,
  }
}

router.post('/document', requireAdmin, (req, res, next) => {
  documentUpload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(
          badRequest(`File must be smaller than ${env.maxUploadBytes / 1024 / 1024}MB.`),
        )
      }
      return next(err)
    }
    if (!req.file) return next(badRequest('No file was uploaded.'))

    res.status(201).json(filePayload(req.file))
  })
})

/**
 * Bulk sync: upload many files and keep original filenames.
 * Field name: `files` (multipart). Admin only.
 * Overwrites existing files with the same name on the server.
 */
router.post('/bulk', requireAdmin, (req, res, next) => {
  bulkUpload.array('files', 100)(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(
          badRequest(`Each file must be smaller than ${env.maxUploadBytes / 1024 / 1024}MB.`),
        )
      }
      if (err.code === 'LIMIT_FILE_COUNT') {
        return next(badRequest('Too many files in one request (max 100).'))
      }
      return next(err)
    }

    const files = req.files || []
    if (!files.length) return next(badRequest('No files were uploaded. Use field name "files".'))

    res.status(201).json({
      count: files.length,
      files: files.map(filePayload),
    })
  })
})

router.post('/', requireAdmin, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(badRequest(`Image must be smaller than ${env.maxUploadBytes / 1024 / 1024}MB.`))
      }
      return next(err)
    }
    if (!req.file) return next(badRequest('No image was uploaded.'))

    res.status(201).json(filePayload(req.file))
  })
})

export default router
