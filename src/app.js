import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import morgan from 'morgan'

import { env } from './lib/env.js'
import { attachUser } from './middleware/auth.js'
import { errorHandler, notFoundHandler } from './middleware/error.js'

import authRoutes from './modules/auth/auth.routes.js'
import productRoutes from './modules/products/product.routes.js'
import orderRoutes from './modules/orders/order.routes.js'
import adminOrderRoutes from './modules/orders/admin-order.routes.js'
import adminUserRoutes from './modules/users/user.routes.js'
import settingsRoutes from './modules/settings/settings.routes.js'
import shippingRoutes from './modules/shipping/shipping.routes.js'
import paymentRoutes from './modules/payments/payment.routes.js'
import uploadRoutes from './modules/uploads/upload.routes.js'

const here = path.dirname(fileURLToPath(import.meta.url))
export const uploadsDir = path.resolve(here, '..', 'uploads')

export function createApp() {
  const app = express()

  app.set('trust proxy', 1)

  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin requests and server-to-server calls send no Origin header.
        if (!origin) return callback(null, true)
        if (env.clientOrigins.includes(origin)) return callback(null, true)
        callback(new Error(`Origin ${origin} is not allowed by CORS.`))
      },
      credentials: true,
    }),
  )

  if (!env.isProd) app.use(morgan('dev'))

  app.use(express.json({ limit: '1mb' }))
  app.use(express.urlencoded({ extended: true }))
  app.use(cookieParser())
  app.use(attachUser)

  app.use('/uploads', express.static(uploadsDir, { maxAge: '30d', fallthrough: true }))

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, env: env.nodeEnv, time: new Date().toISOString() })
  })

  app.use('/api/auth', authRoutes)
  app.use('/api/products', productRoutes)
  app.use('/api/orders', orderRoutes)
  app.use('/api/admin/orders', adminOrderRoutes)
  app.use('/api/admin/users', adminUserRoutes)
  app.use('/api/settings', settingsRoutes)
  app.use('/api/shipping', shippingRoutes)
  app.use('/api/payments', paymentRoutes)
  app.use('/api/uploads', uploadRoutes)

  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}
