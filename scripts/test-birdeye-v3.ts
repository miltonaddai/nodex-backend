/// <reference types="node" />

import 'dotenv/config'

async function main() {
  const key = process.env.BIRDEYE_API_KEY
  const now = Math.floor(Date.now() / 1000)
  const min = now - 30 * 86400
  const url =
    `https://public-api.birdeye.so/defi/v3/token/list?sort_by=price_change_24h_percent&sort_type=desc` +
    `&limit=5&offset=0&min_recent_listing_time=${min}&min_liquidity=30000&min_volume_24h_usd=30000`

  const res = await fetch(url, {
    headers: { 'X-API-KEY': key ?? '', 'x-chain': 'solana' },
  })
  console.log('status', res.status)
  const json = await res.json()
  console.log(JSON.stringify(json, null, 2).slice(0, 3000))
}

main()
