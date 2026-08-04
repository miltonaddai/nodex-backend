/// <reference types="node" />
import { config } from '../src/config'
import { throttleBirdeye } from '../src/services/rate-limit'

/** Is a holder count available for Robinhood tokens anywhere, or only on the list endpoint? */
async function get(path: string, chain: string) {
  await throttleBirdeye()
  const res = await fetch(`${config.birdeye.baseUrl}${path}`, {
    headers: { 'X-API-KEY': config.birdeye.apiKey, 'x-chain': chain },
  })
  const text = await res.text()
  return { status: res.status, text }
}

async function main() {
  // STONKBROKER: a Robinhood-native token with a real listing time.
  const listRes = await get(
    '/defi/v3/token/list?sort_by=volume_24h_usd&sort_type=desc&limit=5&offset=0',
    'robinhood'
  )
  const list = JSON.parse(listRes.text) as { data?: { items?: Record<string, unknown>[] } }
  const sample = (list.data?.items ?? []).find((t) => t.symbol === 'STONKBROKER') ?? list.data?.items?.[0]
  const address = String(sample?.address ?? '')
  console.log('SAMPLE', JSON.stringify({ symbol: sample?.symbol, address }))

  const overview = await get(`/defi/token_overview?address=${address}`, 'robinhood')
  console.log('OVERVIEW_STATUS', overview.status)
  if (overview.status === 200) {
    const json = JSON.parse(overview.text) as { data?: Record<string, unknown> }
    const d = json.data ?? {}
    console.log(
      'OVERVIEW_FIELDS',
      JSON.stringify({
        holder: d.holder,
        uniqueWallet24h: d.uniqueWallet24h ?? d.unique_wallet_24h,
        liquidity: d.liquidity,
        mc: d.mc ?? d.market_cap,
        v24hUSD: d.v24hUSD ?? d.volume_24h_usd,
      })
    )
    console.log('OVERVIEW_KEYS', JSON.stringify(Object.keys(d).sort().slice(0, 40)))
  } else {
    console.log('OVERVIEW_BODY', overview.text.slice(0, 200))
  }

  // How many Robinhood tokens have any holder value at all?
  const wide = await get(
    '/defi/v3/token/list?sort_by=volume_24h_usd&sort_type=desc&limit=100&offset=0',
    'robinhood'
  )
  const wideJson = JSON.parse(wide.text) as { data?: { items?: Record<string, unknown>[] } }
  const items = wideJson.data?.items ?? []
  console.log(
    'HOLDER_COVERAGE',
    JSON.stringify({
      total: items.length,
      with_holder: items.filter((t) => t.holder !== null && t.holder !== undefined).length,
      with_listing_time: items.filter((t) => t.recent_listing_time).length,
      with_unique_wallet: items.filter((t) => t.unique_wallet_24h).length,
    })
  )
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
