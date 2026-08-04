/// <reference types="node" />
import { config } from '../src/config'
import { throttleBirdeye } from '../src/services/rate-limit'

/**
 * Fetches tokens matching the discovery filters and dumps them raw for manual inspection.
 * No quality scoring or classification is applied here.
 *
 * Birdeye allows at most 5 filter params per request, so the most selective go server-side and
 * the remainder are applied client-side from the response body.
 */
const FILTERS = {
  minLiquidity: 70_000,
  minHolder: 1000,
  minFdv: 50_000,
  maxFdv: 10_000_000,
  minTrade24hCount: 1000,
  minVolume24hUsd: 100_000,
  minAgeHours: 1,
  maxAgeDays: 7,
}

interface TokenItem {
  address: string
  symbol: string
  name: string
  holder: number
  fdv: number
  market_cap: number
  liquidity: number
  price: number
  volume_24h_usd: number
  trade_24h_count: number
  unique_wallet_24h: number
  recent_listing_time: number | null
  price_change_24h_percent: number
  volume_buy_24h_usd: number
  volume_sell_24h_usd: number
  buy_24h: number
  sell_24h: number
}

async function fetchPage(offset: number, limit: number): Promise<TokenItem[]> {
  const now = Math.floor(Date.now() / 1000)
  const params = new URLSearchParams({
    sort_by: 'trade_24h_count',
    sort_type: 'desc',
    limit: String(limit),
    offset: String(offset),
    min_recent_listing_time: String(now - FILTERS.maxAgeDays * 86_400),
    max_recent_listing_time: String(now - FILTERS.minAgeHours * 3600),
    min_liquidity: String(FILTERS.minLiquidity),
    min_holder: String(FILTERS.minHolder),
    min_trade_24h_count: String(FILTERS.minTrade24hCount),
  })

  await throttleBirdeye()
  const res = await fetch(`${config.birdeye.baseUrl}/defi/v3/token/list?${params}`, {
    headers: { 'X-API-KEY': config.birdeye.apiKey, 'x-chain': 'solana' },
  })
  if (!res.ok) {
    console.log('HTTP_ERROR', res.status, (await res.text()).slice(0, 300))
    return []
  }
  const json = (await res.json()) as { data?: { items?: TokenItem[] } }
  return json?.data?.items ?? []
}

function ageLabel(listingTime: number | null): string {
  if (!listingTime) return 'unknown'
  const hours = Math.floor((Date.now() / 1000 - listingTime) / 3600)
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

async function main() {
  const all: TokenItem[] = []
  for (let offset = 0; offset < 600; offset += 100) {
    const page = await fetchPage(offset, 100)
    all.push(...page)
    if (page.length < 100) break
  }

  const qualified = all.filter(
    (t) =>
      t.fdv >= FILTERS.minFdv &&
      t.fdv <= FILTERS.maxFdv &&
      t.volume_24h_usd >= FILTERS.minVolume24hUsd
  )

  console.log('FILTERS', JSON.stringify(FILTERS))
  console.log('SERVER_SIDE_MATCHES', all.length)
  console.log('QUALIFIED', qualified.length)

  const rows = qualified
    .map((t) => ({
      symbol: t.symbol,
      name: t.name,
      address: t.address,
      age: ageLabel(t.recent_listing_time),
      holders: t.holder,
      fdv: Math.round(t.fdv),
      mcap: Math.round(t.market_cap),
      liquidity: Math.round(t.liquidity),
      vol24h: Math.round(t.volume_24h_usd),
      trades24h: t.trade_24h_count,
      wallets24h: t.unique_wallet_24h,
      buys24h: t.buy_24h,
      sells24h: t.sell_24h,
      buy_vol_24h: Math.round(t.volume_buy_24h_usd),
      sell_vol_24h: Math.round(t.volume_sell_24h_usd),
      price_change_24h: Math.round(t.price_change_24h_percent * 10) / 10,
      dexscreener: `https://dexscreener.com/solana/${t.address}`,
    }))
    .sort((a, b) => b.holders - a.holders)

  console.log('TOKENS', JSON.stringify(rows, null, 1))
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
