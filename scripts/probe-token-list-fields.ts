/// <reference types="node" />
import { config } from '../src/config'

/**
 * One Birdeye call to confirm which fields the v3 token list actually returns — specifically
 * whether unique_wallet_24h and trade counts are present, since those would give us buyer
 * breadth at discovery time instead of via Helius backfill.
 */
async function main() {
  const params = new URLSearchParams({
    sort_by: 'volume_24h_usd',
    sort_type: 'desc',
    limit: '3',
    offset: '0',
    min_liquidity: '50000',
    min_volume_24h_usd: '100000',
    min_holder: '100',
    min_trade_24h_count: '500',
  })

  const res = await fetch(`${config.birdeye.baseUrl}/defi/v3/token/list?${params}`, {
    headers: { 'X-API-KEY': config.birdeye.apiKey, 'x-chain': 'solana' },
  })
  console.log('STATUS', res.status)
  const json = (await res.json()) as { data?: { items?: Record<string, unknown>[] } }
  const items = json?.data?.items ?? []
  if (items.length === 0) {
    console.log('NO_ITEMS', JSON.stringify(json).slice(0, 400))
    process.exit(0)
  }

  console.log('FIELDS', JSON.stringify(Object.keys(items[0]).sort()))
  for (const item of items) {
    console.log(
      'TOKEN',
      JSON.stringify({
        symbol: item.symbol,
        market_cap: item.market_cap,
        liquidity: item.liquidity,
        holder: item.holder,
        volume_24h_usd: item.volume_24h_usd,
        trade_24h_count: item.trade_24h_count,
        unique_wallet_24h: item.unique_wallet_24h,
        recent_listing_time: item.recent_listing_time,
      })
    )
  }
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
