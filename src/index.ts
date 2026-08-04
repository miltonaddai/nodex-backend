import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import morgan from 'morgan'
import { config } from './config'
import authRoutes from './routes/auth'
import walletRoutes from './routes/wallets'
import tokenRoutes from './routes/tokens'
import watchlistRoutes from './routes/watchlist'
// SUBSCRIPTIONS DISABLED — billing router kept in the tree, just not mounted.
// import billingRoutes, { billingWebhook } from './routes/billing'

const app = express()

// SUBSCRIPTIONS DISABLED — Stripe webhook receiver.
// app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), billingWebhook)

app.use(helmet())

const devOrigins = new Set([
  ...config.allowedOrigins,
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
])

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || devOrigins.has(origin) || config.nodeEnv === 'development') {
        callback(null, true)
        return
      }
      callback(new Error('Not allowed by CORS'))
    },
    credentials: true,
  })
)
app.use(morgan(config.nodeEnv === 'development' ? 'dev' : 'combined'))
app.use(express.json())

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

app.use('/api/auth', authRoutes)
// SUBSCRIPTIONS DISABLED — re-mount to restore checkout/portal/billing endpoints.
// app.use('/api/billing', billingRoutes)
app.use('/api/wallets', walletRoutes)
app.use('/api/tokens', tokenRoutes)
app.use('/api/watchlist', watchlistRoutes)


app.use((_req, res) => {
  res.status(404).json({ message: 'Not found' })
})

app.listen(config.port, () => {
  console.log(`NodeX API running on http://localhost:${config.port}`)
})

export default app
