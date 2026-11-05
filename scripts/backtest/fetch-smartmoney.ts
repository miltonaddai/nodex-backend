/**
 * Wallets-page backtest data: every Solana token the smart-money step listed (tokens the top FOMO traders
 * are net buying), with its first listing and its first listing with 3+ buying wallets, plus 15m Birdeye
 * candles from 24h before the first listing to now. smart_money_buys keeps 7 days (TTL), so tokens already
 * listed in the oldest snapshot are dropped: their real first listing is unknown.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../../src/config'
import { queryClickhouse } from '../../src/services/clickhouse'

const OUT = join(process.env.BACKTEST_DIR ?? join(__dirname, 'data'), 'smartmoney')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  mkdirSync(join(OUT, 'candles'), { recursive: true })
  const snapRow = `toUnixTimestamp(snapshot_at) AS at, wallet_count, buy_usd, sell_usd, net_buy_usd, buy_count,
    toUnixTimestamp(first_buy_at) AS first_buy, toUnixTimestamp(last_buy_at) AS last_buy, price, market_cap, liquidity,
    volume_24h, price_change_24h, buyer_realized_pnl_30d, symbol, name`
  const first = await queryClickhouse<any>(`
    SELECT contract, argMin(tuple(${snapRow.replace(/ AS \w+/g, '')}), snapshot_at) AS t
    FROM smart_money_buys WHERE chain = 'solana' GROUP BY contract
    HAVING min(snapshot_at) > (SELECT min(snapshot_at) FROM smart_money_buys WHERE chain = 'solana')`)
  const keys = snapRow.split(',').map((s) => s.trim().split(/\s+AS\s+/).pop()!.replace(/^toUnixTimestamp\((\w+)\)$/, '$1'))
  const confluence = await queryClickhouse<any>(`
    SELECT contract, toUnixTimestamp(min(snapshot_at)) AS at, argMin(price, snapshot_at) AS price, argMin(wallet_count, snapshot_at) AS wallets
    FROM smart_money_buys WHERE chain = 'solana' AND wallet_count >= 3 GROUP BY contract`)
  const conf = new Map(confluence.map((r) => [r.contract, { at: Number(r.at), price: Number(r.price), wallets: Number(r.wallets) }]))
  const onTokensPage = new Set((await queryClickhouse<any>(`SELECT DISTINCT contract FROM token_analytics WHERE chain = 'solana'`)).map((r) => r.contract))
  const tokens = first.map((r) => {
    const o: any = { contract: r.contract, onTokensPage: onTokensPage.has(r.contract), confluence: conf.get(r.contract) ?? null }
    keys.forEach((k, i) => (o[k === 'at' ? 'firstListedAt' : k] = typeof r.t[i] === 'string' && k !== 'symbol' && k !== 'name' ? Number(r.t[i]) : r.t[i]))
    return o
  })
  writeFileSync(join(OUT, 'tokens.json'), JSON.stringify(tokens))
  console.log(`${tokens.length} tokens first listed after the oldest snapshot; ${tokens.filter((t) => t.confluence).length} reached 3+ wallets`)

  const now = Math.floor(Date.now() / 1000)
  let done = 0
  for (const t of tokens) {
    const file = join(OUT, 'candles', `${t.contract}.json`)
    done++
    if (existsSync(file)) continue
    const p = new URLSearchParams({ address: t.contract, type: '15m', time_from: String(t.firstListedAt - 86_400), time_to: String(now) })
    for (let attempt = 0; attempt < 4; attempt++) {
      await sleep(700)
      const res = await fetch(`${config.birdeye.baseUrl}/defi/ohlcv?${p}`, { headers: { 'X-API-KEY': config.birdeye.apiKey!, 'x-chain': 'solana' }, signal: AbortSignal.timeout(20_000) }).catch(() => null)
      if (res?.ok) {
        const j: any = await res.json()
        writeFileSync(file, JSON.stringify((j?.data?.items ?? []).map((i: any) => ({ t: i.unixTime, o: i.o, h: i.h, l: i.l, c: i.c, v: i.vUsd ?? 0 }))))
        break
      }
      await sleep(3000 * (attempt + 1))
    }
    if (done % 100 === 0) console.log(`${done}/${tokens.length}`)
  }
  console.log('done')
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
