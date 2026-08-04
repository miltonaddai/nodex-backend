/// <reference types="node" />
import { readFileSync } from 'fs'
import { config } from '../src/config'
import { throttleBirdeye } from '../src/services/rate-limit'

/**
 * Compares the two manually-verified legitimate tokens against the rest of the same result set,
 * looking for data points that separate them. Also pulls the `extensions` block, which carries
 * website/twitter/description metadata we have never used.
 */
const LEGIT = new Set(['JORDAN', 'Kimchi'])

interface Row {
  symbol: string
  name: string
  address: string
  age: string
  holders: number
  fdv: number
  mcap: number
  liquidity: number
  vol24h: number
  trades24h: number
  wallets24h: number
  buys24h: number
  sells24h: number
  buy_vol_24h: number
  sell_vol_24h: number
  price_change_24h: number
}

async function fetchExtensions(): Promise<Map<string, Record<string, unknown>>> {
  const now = Math.floor(Date.now() / 1000)
  const params = new URLSearchParams({
    sort_by: 'trade_24h_count',
    sort_type: 'desc',
    limit: '100',
    offset: '0',
    min_recent_listing_time: String(now - 7 * 86_400),
    max_recent_listing_time: String(now - 3600),
    min_liquidity: '70000',
    min_holder: '1000',
    min_trade_24h_count: '1000',
  })
  await throttleBirdeye()
  const res = await fetch(`${config.birdeye.baseUrl}/defi/v3/token/list?${params}`, {
    headers: { 'X-API-KEY': config.birdeye.apiKey, 'x-chain': 'solana' },
  })
  const json = (await res.json()) as {
    data?: { items?: { address: string; extensions?: Record<string, unknown> }[] }
  }
  const map = new Map<string, Record<string, unknown>>()
  for (const item of json?.data?.items ?? []) {
    map.set(item.address, item.extensions ?? {})
  }
  return map
}

function main(rows: Row[], extensions: Map<string, Record<string, unknown>>) {
  const analysed = rows.map((r) => {
    const ext = extensions.get(r.address) ?? {}
    const socialFields = ['website', 'twitter', 'telegram', 'discord', 'description']
    const socials = socialFields.filter((f) => {
      const value = ext[f]
      return typeof value === 'string' && value.trim().length > 0
    })
    return {
      symbol: r.symbol,
      legit: LEGIT.has(r.symbol) ? 'LEGIT' : 'scam',
      age: r.age,
      // Traders per holder. Organic tokens churn (traders pass through without holding);
      // a bot-seeded holder base produces almost exactly one trading wallet per holder.
      churn: Math.round((r.wallets24h / Math.max(r.holders, 1)) * 100) / 100,
      // Trade counts, not volume: volume is trivially faked by cycling size.
      buy_sell_count: Math.round((r.buys24h / Math.max(r.sells24h, 1)) * 100) / 100,
      vol_per_holder: Math.round(r.vol24h / Math.max(r.holders, 1)),
      trades_per_wallet: Math.round((r.trades24h / Math.max(r.wallets24h, 1)) * 10) / 10,
      liq_to_fdv: Math.round((r.liquidity / Math.max(r.fdv, 1)) * 1000) / 1000,
      socials: socials.length,
      social_fields: socials.join(','),
    }
  })

  analysed.sort((a, b) => b.churn - a.churn)
  for (const a of analysed) {
    console.log(
      [
        a.legit.padEnd(5),
        a.symbol.padEnd(10),
        `age=${a.age}`.padEnd(9),
        `churn=${a.churn}`.padEnd(12),
        `b/s=${a.buy_sell_count}`.padEnd(10),
        `vol/holder=${a.vol_per_holder}`.padEnd(18),
        `trades/wallet=${a.trades_per_wallet}`.padEnd(20),
        `liq/fdv=${a.liq_to_fdv}`.padEnd(14),
        `socials=${a.socials}`,
        a.social_fields,
      ].join(' ')
    )
  }
}

async function run() {
  const log = readFileSync(process.argv[2] ?? '/tmp/raw.log', 'utf8')
  const rows: Row[] = JSON.parse(log.slice(log.indexOf('TOKENS ') + 'TOKENS '.length))
  const extensions = await fetchExtensions()
  main(rows, extensions)
  process.exit(0)
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
