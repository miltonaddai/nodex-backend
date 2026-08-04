/// <reference types="node" />
import { config } from '../src/config'
import { throttleBirdeye } from '../src/services/rate-limit'

/**
 * Checks whether Birdeye serves the Robinhood chain, and whether the fields the churn screen
 * depends on (holder, unique_wallet_24h, recent_listing_time) are actually populated there.
 */
async function probe(chain: string, withFilters: boolean) {
  const now = Math.floor(Date.now() / 1000)
  const params = new URLSearchParams({
    sort_by: 'volume_24h_usd',
    sort_type: 'desc',
    limit: '10',
    offset: '0',
  })
  if (withFilters) {
    params.set('min_recent_listing_time', String(now - 14 * 86_400))
    params.set('min_liquidity', '15000')
    params.set('min_holder', '150')
  }

  await throttleBirdeye()
  const res = await fetch(`${config.birdeye.baseUrl}/defi/v3/token/list?${params}`, {
    headers: { 'X-API-KEY': config.birdeye.apiKey, 'x-chain': chain },
  })
  const text = await res.text()
  if (!res.ok) {
    console.log(`${chain} filters=${withFilters} STATUS=${res.status}`, text.slice(0, 200))
    return
  }
  const json = JSON.parse(text) as { data?: { items?: Record<string, unknown>[] } }
  const items = json?.data?.items ?? []
  console.log(`${chain} filters=${withFilters} STATUS=${res.status} items=${items.length}`)
  for (const t of items.slice(0, 5)) {
    console.log(
      '  ',
      JSON.stringify({
        symbol: t.symbol,
        holder: t.holder,
        unique_wallet_24h: t.unique_wallet_24h,
        trade_24h_count: t.trade_24h_count,
        liquidity: t.liquidity,
        volume_24h_usd: t.volume_24h_usd,
        fdv: t.fdv,
        recent_listing_time: t.recent_listing_time,
      })
    )
  }
}

async function main() {
  await probe('robinhood', false)
  await probe('robinhood', true)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
