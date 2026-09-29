import { config } from '../config'

/**
 * FOMO API (fomoapi.io): the FOMO app's trader leaderboards, with each trader's wallets.
 * Billed in credits: a leaderboard read costs 250 of the free plan's 250,000 a month.
 */
const BASE_URL = 'https://api.fomoapi.io'

export type LeaderboardWindow = '24h' | '7d' | '30d' | 'all'

export interface FomoLeaderboardTrader {
  rank: number
  handle: string
  userId: string
  displayName: string
  pnlUsd: number
  volumeUsd: number
  trades: number
  followers: number
  avatar?: string
  wallets?: { solana?: string | null; evm?: string | null; verified?: boolean }
}

/** One leaderboard window. FOMO caps it at 150 traders (100 for all-time), with no paging. */
export async function getFomoLeaderboard(window: LeaderboardWindow, limit = 150): Promise<FomoLeaderboardTrader[]> {
  if (!config.fomo.apiKey) throw new Error('FOMO_API_KEY is not set')
  const res = await fetch(`${BASE_URL}/v2/leaderboard/${window}?limit=${limit}`, {
    headers: { authorization: `Bearer ${config.fomo.apiKey}` },
    signal: AbortSignal.timeout(config.worker.providerRequestTimeoutMs),
  })
  if (!res.ok) throw new Error(`FOMO leaderboard ${window} error ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const body = (await res.json()) as { traders?: FomoLeaderboardTrader[] }
  return body.traders ?? []
}

export interface FomoAlert {
  eventId: string
  type: string
  trader: string
  userId: string
  token: string
  tokenAddress: string
  chain: string
  usdValue: number | null
  /** Unix milliseconds. */
  ts: number
}

/**
 * FOMO's trade feed: buys or sells by FOMO users, newest first, 125 credits per call. On Robinhood
 * Chain FOMO submits trades through a relayer, so the relayer, not the trader's wallet, sends
 * the swap and wallet-based swap history misses them. The feed reports them per trader.
 */
export async function getFomoAlerts(opts: {
  type: 'buy' | 'sell'
  chain: string
  since?: Date
  limit?: number
}): Promise<FomoAlert[]> {
  if (!config.fomo.apiKey) throw new Error('FOMO_API_KEY is not set')
  const params = new URLSearchParams({ type: opts.type, chain: opts.chain, limit: String(opts.limit ?? 200) })
  if (opts.since) params.set('since', opts.since.toISOString())
  const res = await fetch(`${BASE_URL}/v2/alerts?${params}`, {
    headers: { authorization: `Bearer ${config.fomo.apiKey}` },
    signal: AbortSignal.timeout(config.worker.providerRequestTimeoutMs),
  })
  if (!res.ok) throw new Error(`FOMO alerts error ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const body = (await res.json()) as { alerts?: FomoAlert[] }
  return body.alerts ?? []
}
