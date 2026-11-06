import { config } from '../config'
import { SUPPORTED_CHAINS } from '../lib/chains'
import { matchesRules } from '../lib/custom-filters'
import { isEarlySignal } from '../lib/early-signal'
import { formatAlertMessage } from '../lib/telegram-format'
import { listAlerts } from '../services/alerts-store'
import { loadBuysSnapshot, type BuyItem } from '../services/smart-money-snapshot'
import { isUserSubscriptionEntitled } from '../services/subscription-access'
import { isTelegramConfigured, sendMessage, TelegramChatGoneError } from '../services/telegram'
import {
  getDelivered,
  listLinks,
  pruneDeliveries,
  recordDelivered,
  STARTED,
  unlinkChat,
  type TelegramLink,
} from '../services/telegram-store'

/**
 * Sends alerts to linked Telegram chats. Runs in the worker right after the smart-money step, so
 * alerts go out within moments of new data, whether or not the user has WhaleMo open.
 *
 * For each linked user with an active subscription it checks the built-in early-signal alert (if
 * they kept it on for Telegram) and each of their alerts with Telegram on, against the fresh
 * snapshot on each chain the alert covers. Each token is sent once per alert. The first check of
 * a new alert only records what already matches, so creating one doesn't flood the chat.
 */

/** Telegram allows about one message a second to a chat. */
const PER_CHAT_GAP_MS = 1_100
/** Delivery records older than this are dropped; tokens leave the buying window long before. */
const KEEP_DELIVERIES_DAYS = 30

interface Watch {
  key: string
  title: string
  chains: string[]
  matches: (item: BuyItem) => boolean
  viewPath: (chain: string) => string
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function watchesFor(link: TelegramLink): Promise<Watch[]> {
  const watches: Watch[] = []
  if (link.earlySignals) {
    watches.push({
      key: 'early',
      title: 'Early signal',
      chains: [...SUPPORTED_CHAINS],
      matches: (item) => isEarlySignal(item),
      viewPath: (chain) => `/wallets?preset=early&chain=${chain}`,
    })
  }
  for (const alert of await listAlerts(link.userId)) {
    if (!alert.enabled || !alert.telegram || alert.rules.length === 0) continue
    watches.push({
      key: alert.id,
      title: `Alert: ${alert.name}`,
      chains: alert.chains,
      matches: (item) => matchesRules(item, alert.rules),
      viewPath: (chain) => `/wallets?alert=${alert.id}&chain=${chain}`,
    })
  }
  return watches
}

export async function deliverTelegramAlerts(): Promise<void> {
  if (!isTelegramConfigured()) {
    console.log('[telegram-alerts] TELEGRAM_BOT_TOKEN / TELEGRAM_BOT_USERNAME not set, skipping')
    return
  }
  const links = await listLinks()
  if (links.length === 0) return

  // Each chain's snapshot is loaded once per run, on first use.
  const snapshots = new Map<string, Promise<BuyItem[]>>()
  const itemsFor = (chain: string) => {
    if (!snapshots.has(chain)) snapshots.set(chain, loadBuysSnapshot(chain).then((s) => s.items).catch(() => []))
    return snapshots.get(chain)!
  }

  let sent = 0
  let started = 0
  for (const link of links) {
    try {
      // Only paying users get alerts. With the paywall off, everyone signed in counts.
      if (config.subscriptionsEnabled && !(await isUserSubscriptionEntitled(link.userId))) continue
      let lastSentAt = 0
      for (const watch of await watchesFor(link)) {
        for (const chain of watch.chains) {
          const matches = (await itemsFor(chain)).filter(watch.matches)
          const delivered = await getDelivered(link.userId, watch.key, chain)
          if (!delivered.has(STARTED)) {
            await recordDelivered(link.userId, watch.key, chain, [STARTED, ...matches.map((item) => item.contract)])
            started++
            continue
          }
          // Strongest first: most top traders, then the most net bought.
          const fresh = matches
            .filter((item) => !delivered.has(item.contract))
            .sort((a, b) => b.walletCount - a.walletCount || b.netBuyUsd - a.netBuyUsd)
          if (fresh.length === 0) continue

          const wait = lastSentAt + PER_CHAT_GAP_MS - Date.now()
          if (wait > 0) await sleep(wait)
          await sendMessage(link.chatId, formatAlertMessage(watch.title, chain, fresh), [
            [{ text: 'Open in WhaleMo', url: `${config.frontendUrl}${watch.viewPath(chain)}` }],
          ])
          lastSentAt = Date.now()
          await recordDelivered(link.userId, watch.key, chain, fresh.map((item) => item.contract))
          sent++
        }
      }
    } catch (error) {
      if (error instanceof TelegramChatGoneError) {
        // Blocked the bot or deleted the chat: stop trying.
        await unlinkChat(link.chatId).catch(() => {})
        console.log(`[telegram-alerts] Chat for user ${link.userId} is gone; unlinked`)
      } else {
        // One user's failure never stops the others.
        console.warn(`[telegram-alerts] Failed for user ${link.userId}:`, error instanceof Error ? error.message : error)
      }
    }
  }

  await pruneDeliveries(KEEP_DELIVERIES_DAYS).catch(() => {})
  console.log(`[telegram-alerts] ${links.length} linked chats: ${sent} messages sent, ${started} new alerts started`)
}
