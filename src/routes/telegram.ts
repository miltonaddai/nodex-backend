import { timingSafeEqual } from 'node:crypto'
import { Router, Request, Response } from 'express'
import { config } from '../config'
import { authMiddleware, AuthRequest } from '../middleware/auth'
import { subscriptionMiddleware } from '../middleware/subscription'
import { isTelegramConfigured, sendMessage } from '../services/telegram'
import {
  consumeLinkCode,
  createLinkCode,
  getLink,
  getLinkByChat,
  linkChat,
  setEarlySignals,
  unlinkChat,
  unlinkUser,
} from '../services/telegram-store'

/**
 * Telegram alerts: linking a chat to an account, the user's Telegram settings, and the webhook
 * Telegram calls when someone messages the bot. Sending happens in the worker
 * (workers/telegram-alerts.ts).
 */
const router = Router()

/** Whether Telegram is set up, and the user's link. */
router.get('/status', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const link = isTelegramConfigured() ? await getLink(req.user!.id) : null
    res.json({
      configured: isTelegramConfigured(),
      botUsername: config.telegram.botUsername || null,
      linked: Boolean(link),
      username: link?.username ?? null,
      earlySignals: link?.earlySignals ?? true,
    })
  } catch (error) {
    console.error('Failed to read Telegram status:', error)
    res.status(500).json({ message: 'Could not load your Telegram connection' })
  }
})

/** A single-use t.me link that connects the user's Telegram chat when they press Start. */
router.post('/link', authMiddleware, subscriptionMiddleware, async (req: AuthRequest, res: Response) => {
  if (!isTelegramConfigured()) return res.status(503).json({ message: 'Telegram alerts are not set up yet' })
  try {
    const { code, expiresAt } = await createLinkCode(req.user!.id)
    res.json({ url: `https://t.me/${config.telegram.botUsername}?start=${code}`, expiresAt })
  } catch (error) {
    console.error('Failed to create Telegram link:', error)
    res.status(500).json({ message: 'Could not create a Telegram link' })
  }
})

router.delete('/link', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const link = await getLink(req.user!.id)
    await unlinkUser(req.user!.id)
    if (link && isTelegramConfigured()) {
      await sendMessage(link.chatId, 'This chat was disconnected from WhaleMo. You won’t get alerts here any more.').catch(() => {})
    }
    res.json({ success: true })
  } catch (error) {
    console.error('Failed to unlink Telegram:', error)
    res.status(500).json({ message: 'Could not disconnect Telegram' })
  }
})

/** { earlySignals: boolean }: whether the built-in early-signal alert goes to Telegram. */
router.patch('/settings', authMiddleware, subscriptionMiddleware, async (req: AuthRequest, res: Response) => {
  if (typeof req.body?.earlySignals !== 'boolean') return res.status(400).json({ message: 'earlySignals must be true or false' })
  try {
    const link = await setEarlySignals(req.user!.id, req.body.earlySignals)
    if (!link) return res.status(400).json({ message: 'Connect Telegram first' })
    res.json({ earlySignals: link.earlySignals })
  } catch (error) {
    console.error('Failed to update Telegram settings:', error)
    res.status(500).json({ message: 'Could not update your Telegram settings' })
  }
})

/* ---------- Webhook ---------- */

/** Only Telegram knows the secret it sends with every webhook call. */
function fromTelegram(req: Request): boolean {
  const expected = config.telegram.webhookSecret
  const given = req.header('x-telegram-bot-api-secret-token') ?? ''
  if (!expected || given.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected))
}

const reply = (chatId: number, text: string) => sendMessage(chatId, text).catch((error) => console.warn('[telegram] Reply failed:', error))

const appUrl = () => config.frontendUrl
const HOW_TO_LINK = () =>
  `To get WhaleMo alerts here, open WhaleMo → Alerts → <b>Connect Telegram</b>, then press Start on the link it opens.\n${appUrl()}/alerts`

interface Update {
  message?: {
    text?: string
    chat?: { id: number; type?: string }
    from?: { username?: string; first_name?: string }
  }
}

router.post('/webhook', async (req: Request, res: Response) => {
  if (!fromTelegram(req)) return res.status(401).json({ ok: false })
  // Answer at once; Telegram retries slow webhooks.
  res.json({ ok: true })

  const message = (req.body as Update)?.message
  const chatId = message?.chat?.id
  const text = message?.text?.trim() ?? ''
  if (!chatId || !text.startsWith('/')) return
  const [command, argument] = text.split(/\s+/, 2)
  const name = command.split('@')[0].toLowerCase()

  try {
    if (name === '/start') {
      if (!argument) {
        const link = await getLinkByChat(chatId)
        await reply(chatId, link ? '✅ This chat is linked to WhaleMo. Your alerts arrive here.' : `👋 ${HOW_TO_LINK()}`)
        return
      }
      const userId = await consumeLinkCode(argument)
      if (!userId) {
        await reply(chatId, `That link has expired or was already used. ${HOW_TO_LINK()}`)
        return
      }
      await linkChat(userId, chatId, message?.from?.username ?? message?.from?.first_name ?? null)
      await reply(
        chatId,
        '✅ <b>Connected to WhaleMo.</b>\nYour alerts will arrive here after each data update (about every 2 hours). Choose which ones in WhaleMo → Alerts.\n\nSend /stop to disconnect.'
      )
    } else if (name === '/stop') {
      await unlinkChat(chatId)
      await reply(chatId, 'Disconnected. You won’t get WhaleMo alerts here any more. Connect again from WhaleMo → Alerts.')
    } else if (name === '/status') {
      const link = await getLinkByChat(chatId)
      await reply(chatId, link ? '✅ This chat is linked to WhaleMo.' : `This chat isn’t linked. ${HOW_TO_LINK()}`)
    }
  } catch (error) {
    console.error('[telegram] Webhook handling failed:', error)
  }
})

export default router
