import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import morgan from 'morgan'
import { config } from './config'
import authRoutes from './routes/auth'
import walletRoutes from './routes/wallets'
import tokenRoutes from './routes/tokens'
import insiderRoutes from './routes/insiders'
import smartMoneyRoutes from './routes/smart-money'
import scannerRoutes from './routes/scanner'
import watchlistRoutes from './routes/watchlist'
import filterRoutes from './routes/filters'
import alertRoutes from './routes/alerts'
import telegramRoutes from './routes/telegram'
import { registerWebhook } from './services/telegram'
import billingRoutes, { billingWebhook } from './routes/billing'

const app = express()

// Stripe webhook receiver. Registered before express.json() because it needs the raw body.
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), billingWebhook)

app.use(helmet())

const devOrigins = new Set([
  ...config.allowedOrigins,
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
])

//railway deployment 

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
app.use('/api/billing', billingRoutes)
app.use('/api/wallets', walletRoutes)
app.use('/api/tokens', tokenRoutes)
app.use('/api/insiders', insiderRoutes)
app.use('/api/smart-money', smartMoneyRoutes)
app.use('/api/scanner', scannerRoutes)
app.use('/api/watchlist', watchlistRoutes)
app.use('/api/filters', filterRoutes)
app.use('/api/alerts', alertRoutes)
app.use('/api/telegram', telegramRoutes)


app.use((_req, res) => {
  res.status(404).json({ message: 'Not found' })
})

app.listen(config.port, () => {
  console.log(`WhaleMo API running on http://localhost:${config.port}`)
  // Points the Telegram bot at this API's webhook when API_PUBLIC_URL is set. Safe on every start.
  registerWebhook()
    .then(() => config.telegram.apiPublicUrl && config.telegram.botToken && console.log('[telegram] Webhook registered'))
    .catch((error) => console.warn('[telegram] Could not register the webhook:', error instanceof Error ? error.message : error))
})

export default app
