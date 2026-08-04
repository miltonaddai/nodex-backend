/// <reference types="node" />
import { config } from '../src/config'
import { throttleBirdeye } from '../src/services/rate-limit'

/**
 * Scans the discovery window deeply and reports the churn distribution.
 *
 * churn = unique_wallet_24h / holder. Bot farms mint one wallet per holder and trade each once,
 * pinning this at ~1.00. Organic trading breaks that identity — traders exit (no longer holders)
 * while other holders stay put — pushing it above 1.5. Seeded bundles sit near 0.
 *
 * Churn is not a server-side filter, so it is computed from the response after the five
 * server-side slots are spent on liquidity, holders, trade count and the listing window.
 */
const num = (key: string, fallback: number) => Number(process.env[key] ?? fallback)

const SERVER = {
  minLiquidity: num('SCAN_MIN_LIQ', 70_000),
  minHolder: num('SCAN_MIN_HOLDER', 1000),
  minTrade24hCount: num('SCAN_MIN_TRADES', 1000),
  minAgeHours: num('SCAN_MIN_AGE_H', 1),
  maxAgeDays: num('SCAN_MAX_AGE_D', 7),
}
const CLIENT = {
  minFdv: num('SCAN_MIN_FDV', 50_000),
  maxFdv: num('SCAN_MAX_FDV', 10_000_000),
  minVolume24hUsd: num('SCAN_MIN_VOL', 100_000),
  minChurn: num('SCAN_MIN_CHURN', 1.5),
  maxBuySellCountRatio: num('SCAN_MAX_BS', 2),
}
const PAGES = 8

interface TokenItem {
  address: string
  symbol: string
  name: string
  holder: number
  fdv: number
  market_cap: number
  liquidity: number
  volume_24h_usd: number
  trade_24h_count: number
  unique_wallet_24h: number
  recent_listing_time: number | null
  buy_24h: number
  sell_24h: number
  price_change_24h_percent: number
}

async function fetchPage(offset: number, sortBy: string): Promise<TokenItem[]> {
  const now = Math.floor(Date.now() / 1000)
  const params = new URLSearchParams({
    sort_by: sortBy,
    sort_type: 'desc',
    limit: '100',
    offset: String(offset),
    min_recent_listing_time: String(now - SERVER.maxAgeDays * 86_400),
    max_recent_listing_time: String(now - SERVER.minAgeHours * 3600),
    min_liquidity: String(SERVER.minLiquidity),
    min_holder: String(SERVER.minHolder),
    min_trade_24h_count: String(SERVER.minTrade24hCount),
  })
  await throttleBirdeye()
  const res = await fetch(`${config.birdeye.baseUrl}/defi/v3/token/list?${params}`, {
    headers: { 'X-API-KEY': config.birdeye.apiKey, 'x-chain': 'solana' },
  })
  if (!res.ok) {
    console.log('HTTP_ERROR', res.status, (await res.text()).slice(0, 200))
    return []
  }
  const json = (await res.json()) as { data?: { items?: TokenItem[] } }
  return json?.data?.items ?? []
}

function ageLabel(t: number | null): string {
  if (!t) return '?'
  const h = Math.floor((Date.now() / 1000 - t) / 3600)
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`
}

async function main() {
  const seen = new Map<string, TokenItem>()
  // Two sort orders so we do not only see the most-traded slice, where farms concentrate.
  for (const sortBy of ['trade_24h_count', 'holder']) {
    for (let page = 0; page < PAGES / 2; page++) {
      const items = await fetchPage(page * 100, sortBy)
      for (const item of items) seen.set(item.address, item)
      if (items.length < 100) break
    }
  }

  const all = [...seen.values()]
  const eligible = all.filter(
    (t) =>
      t.fdv >= CLIENT.minFdv &&
      t.fdv <= CLIENT.maxFdv &&
      t.volume_24h_usd >= CLIENT.minVolume24hUsd &&
      t.holder > 0
  )

  const churnOf = (t: TokenItem) => t.unique_wallet_24h / t.holder
  const buckets = {
    'bundle (<0.5)': eligible.filter((t) => churnOf(t) < 0.5).length,
    'farm (0.5-1.2)': eligible.filter((t) => churnOf(t) >= 0.5 && churnOf(t) < 1.2).length,
    'grey (1.2-1.5)': eligible.filter((t) => churnOf(t) >= 1.2 && churnOf(t) < 1.5).length,
    'organic (>=1.5)': eligible.filter((t) => churnOf(t) >= 1.5).length,
  }

  console.log('SCANNED', all.length)
  console.log('ELIGIBLE', eligible.length)
  console.log('CHURN_BUCKETS', JSON.stringify(buckets))

  const candidates = eligible
    .filter((t) => churnOf(t) >= CLIENT.minChurn)
    .filter((t) => t.buy_24h / Math.max(t.sell_24h, 1) <= CLIENT.maxBuySellCountRatio)
    .sort((a, b) => churnOf(b) - churnOf(a))

  console.log('CANDIDATES', candidates.length)
  for (const t of candidates) {
    console.log(
      [
        t.symbol.padEnd(12),
        (t.name ?? '').slice(0, 24).padEnd(25),
        `age=${ageLabel(t.recent_listing_time)}`.padEnd(9),
        `churn=${(churnOf(t)).toFixed(2)}`.padEnd(12),
        `holders=${t.holder}`.padEnd(15),
        `wallets=${t.unique_wallet_24h}`.padEnd(15),
        `fdv=${Math.round(t.fdv / 1000)}k`.padEnd(12),
        `liq=${Math.round(t.liquidity / 1000)}k`.padEnd(10),
        `vol=${Math.round(t.volume_24h_usd / 1000)}k`.padEnd(12),
        `b/s=${(t.buy_24h / Math.max(t.sell_24h, 1)).toFixed(2)}`.padEnd(10),
        t.address,
      ].join(' ')
    )
  }
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
