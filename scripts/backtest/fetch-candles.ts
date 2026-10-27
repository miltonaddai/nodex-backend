/**
 * Backtest data: 15m Birdeye candles for every tokens-page token first seen this month, from 24h
 * before first sighting to now. Cached per token so re-runs only fetch what is missing.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../../src/config'
import { queryClickhouse } from '../../src/services/clickhouse'

const OUT = process.env.BACKTEST_DIR ?? join(__dirname, 'data')
const SINCE = process.env.BACKTEST_SINCE ?? '2026-10-01'
/** 15m candles for the first days after discovery (< 1000 per request), 1H after that. */
const FINE = 8 * 86_400
/** Birdeye allows 100 requests a minute on this key; share one spacing across workers. */
const SPACING_MS = 650
let nextSlot = 0

export interface TokenMeta {
  chain: string
  contract: string
  symbol: string
  firstSeen: number
  firstPrice: number
  firstMc: number
  launchedAt: number
  peakPrice: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function throttle(): Promise<void> {
  const wait = Math.max(0, nextSlot - Date.now())
  nextSlot = Math.max(Date.now(), nextSlot) + SPACING_MS
  await sleep(wait)
}

async function ohlcv(chain: string, address: string, type: '15m' | '1H', from: number, to: number): Promise<any[]> {
  const p = new URLSearchParams({ address, type, time_from: String(from), time_to: String(to) })
  for (let attempt = 0; attempt < 4; attempt++) {
    await throttle()
    const res = await fetch(`${config.birdeye.baseUrl}/defi/ohlcv?${p}`, {
      headers: { 'X-API-KEY': config.birdeye.apiKey!, 'x-chain': chain },
      signal: AbortSignal.timeout(20_000),
    }).catch(() => null)
    if (res?.ok) {
      const j: any = await res.json()
      return (j?.data?.items ?? []).map((i: any) => ({ t: i.unixTime, o: i.o, h: i.h, l: i.l, c: i.c, v: i.vUsd ?? 0 }))
    }
    await sleep(3000 * (attempt + 1))
  }
  throw new Error(`ohlcv failed ${chain} ${address}`)
}

async function main() {
  mkdirSync(join(OUT, 'candles'), { recursive: true })
  const tokens = (
    await queryClickhouse<any>(
      `SELECT s.chain AS chain, s.contract AS contract, any(a.symbol) AS symbol,
         toUnixTimestamp(any(s.first_seen_at)) AS fs, any(s.first_price) AS fp, any(s.first_mc) AS fmc,
         any(s.peak_price) AS pp, toUnixTimestamp(any(a.launched_at)) AS la
       FROM token_sightings AS s FINAL
       INNER JOIN (SELECT chain, contract, symbol, launched_at FROM token_analytics FINAL
                   WHERE churn_qualified = 1 AND period_days = 1) AS a
         ON a.chain = s.chain AND a.contract = s.contract
       WHERE s.chain = 'solana' AND s.first_seen_at >= {since:String} AND s.first_price > 0
       GROUP BY s.chain, s.contract`,
      { since: SINCE }
    )
  ).map(
    (r): TokenMeta => ({
      chain: r.chain, contract: r.contract, symbol: r.symbol, firstSeen: Number(r.fs),
      firstPrice: Number(r.fp), firstMc: Number(r.fmc), launchedAt: Number(r.la), peakPrice: Number(r.pp),
    })
  )
  writeFileSync(join(OUT, 'tokens.json'), JSON.stringify(tokens))
  console.log(`${tokens.length} tokens`)
  const now = Math.floor(Date.now() / 1000)
  let done = 0
  const queue = [...tokens]
  const worker = async () => {
    for (let t = queue.shift(); t; t = queue.shift()) {
      const file = join(OUT, 'candles', `${t.chain}-${t.contract}.json`)
      done++
      if (existsSync(file)) continue
      try {
        const fineEnd = Math.min(now, t.firstSeen + FINE)
        const candles = await ohlcv(t.chain, t.contract, '15m', t.firstSeen - 86_400, fineEnd)
        if (fineEnd < now) candles.push(...(await ohlcv(t.chain, t.contract, '1H', fineEnd, now)))
        writeFileSync(file, JSON.stringify(candles))
      } catch (e) {
        console.warn(String(e))
      }
      if (done % 100 === 0) console.log(`${done}/${tokens.length}`)
    }
  }
  await Promise.all([worker(), worker(), worker()])
  console.log('done')
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
