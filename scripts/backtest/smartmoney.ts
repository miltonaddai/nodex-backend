/**
 * Wallets-page backtest: buying tokens when the top FOMO traders' net buying first lists them
 * (data from fetch-smartmoney.ts). Same execution model as backtest.ts: entry at the open of the first
 * 15m candle after listing, 1.5% cost per side, stop checked before target inside a candle.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { simulate, type Candle, type Trade } from './backtest'

const DIR = join(process.env.BACKTEST_DIR ?? join(__dirname, 'data'), 'smartmoney')
const cost = 0.985 ** 2
const raw: any[] = JSON.parse(readFileSync(join(DIR, 'tokens.json'), 'utf8'))

function build(at: number, refPrice: number, t: any): Trade | null {
  const file = join(DIR, 'candles', `${t.contract}.json`)
  if (!existsSync(file)) return null
  const all: Candle[] = (JSON.parse(readFileSync(file, 'utf8')) as Candle[]).filter((c) => c.o > 0 && c.h > 0 && c.l > 0).sort((a, b) => a.t - b.t)
  const i = all.findIndex((c) => c.t >= at)
  if (i < 0 || all.length - i < 2) return null
  const entry = all[i].o
  if (refPrice > 0 && (entry / refPrice > 3 || entry / refPrice < 1 / 3)) return null // bad quote
  return { token: { chain: 'solana', contract: t.contract, symbol: t.symbol, firstSeen: at, firstPrice: refPrice, firstMc: t.market_cap, launchedAt: 0, peakPrice: 0 } as any,
    entryAt: all[i].t, entry, path: all.slice(i), pre: all.slice(0, i), f: {} as any }
}
const SPLIT = Date.parse('2026-10-24T00:00:00Z') / 1000
const entries = raw.map((t) => ({ t, tr: build(t.firstListedAt, t.price, t) })).filter((x) => x.tr) as { t: any; tr: Trade }[]
const conf = raw.filter((t) => t.confluence).map((t) => ({ t, tr: build(t.confluence.at, t.confluence.price, t) })).filter((x) => x.tr) as { t: any; tr: Trade }[]

const peak = (tr: Trade, h = 72) => Math.max(...tr.path.filter((c) => c.t - tr.entryAt < h * 3600).map((c) => c.h)) / tr.entry
const clean2x = (tr: Trade) => { for (const c of tr.path) { if (c.l <= tr.entry * 0.7) return false; if (c.h >= tr.entry * 2) return true } return false }
const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(p * (s.length - 1))] }
function shape(label: string, xs: { tr: Trade }[]) {
  const pk = xs.map((x) => peak(x.tr))
  const pct = (f: (x: { tr: Trade }) => boolean) => Math.round((xs.filter(f).length / xs.length) * 100)
  console.log(`\n${label}: ${xs.length} trades`)
  console.log(`  peak within 72h: median ${q(pk, 0.5).toFixed(2)}x · reached 1.5x ${pct((x) => peak(x.tr) >= 1.5)}% · 2x ${pct((x) => peak(x.tr) >= 2)}% · 3x ${pct((x) => peak(x.tr) >= 3)}% · 5x ${pct((x) => peak(x.tr) >= 5)}%`)
  console.log(`  hit 2x before -30%: ${pct((x) => clean2x(x.tr))}% · median low in first 24h ${q(xs.map((x) => Math.min(...x.tr.path.filter((c) => c.t - x.tr.entryAt < 86400).map((c) => c.l)) / x.tr.entry), 0.5).toFixed(2)}x · median price today ${q(xs.map((x) => x.tr.path[x.tr.path.length - 1].c / x.tr.entry), 0.5).toFixed(2)}x`)
}
const RULES: [string, any][] = [
  ['sell after 1h', { maxHours: 1 }], ['sell after 24h', { maxHours: 24 }], ['hold to today', {}],
  ['2x / -30%', { tp: 2, sl: 0.7 }], ['2x / -50%', { tp: 2, sl: 0.5 }], ['2x / -70% (SurgeBot now)', { tp: 2, sl: 0.3, maxHours: 72 }],
  ['1.5x / -30%', { tp: 1.5, sl: 0.7 }], ['1.3x / -20%', { tp: 1.3, sl: 0.8 }], ['3x / -50%', { tp: 3, sl: 0.5 }], ['5x / 72h', { tp: 5, maxHours: 72 }],
]
function rules(label: string, xs: { tr: Trade }[]) {
  console.log(`\n${label} ($100 per trade)        total   w/o top 5   Oct 20-23   Oct 24-27   win%`)
  for (const [name, r] of RULES) {
    const nets = xs.map((x) => ({ at: x.tr.entryAt, n: simulate(x.tr, { name, ...r }).mult * cost - 1 }))
    const s = nets.map((x) => x.n).sort((a, b) => a - b)
    const sum = (ys: typeof nets) => Math.round(ys.reduce((a, y) => a + y.n * 100, 0))
    console.log(`  ${name.padEnd(28)} ${String(sum(nets)).padStart(6)}  ${String(Math.round(s.slice(0, -5).reduce((a, n) => a + n * 100, 0))).padStart(9)}  ${String(sum(nets.filter((y) => y.at < SPLIT))).padStart(10)}  ${String(sum(nets.filter((y) => y.at >= SPLIT))).padStart(10)}   ${Math.round(nets.filter((y) => y.n > 0).length / nets.length * 100)}`)
  }
}

shape('A) Buy when first listed on the Wallets page', entries)
rules('A) first listing', entries)
shape('B) Buy when 3+ FOMO wallets are in', conf)
rules('B) 3+ wallets', conf)

// What separates winners at first listing (all data known at listing time)
const vol1hShare = (tr: Trade) => { const pre = tr.pre.filter((c) => c.t >= tr.entryAt - 86400); const d = pre.reduce((a, c) => a + c.v, 0); return pre.filter((c) => c.t >= tr.entryAt - 3600).reduce((a, c) => a + c.v, 0) / Math.max(1, d) }
const run24 = (tr: Trade) => { const pre = tr.pre.filter((c) => c.t >= tr.entryAt - 86400); return pre.length ? tr.entry / Math.min(...pre.map((c) => c.l)) : 1 }
const feats: [string, (x: { t: any; tr: Trade }) => number, number[]][] = [
  ['wallets buying', (x) => x.t.wallet_count, [2, 3, 4]],
  ['net buy $ (all wallets)', (x) => x.t.net_buy_usd, [500, 1500, 5000]],
  ['buys', (x) => x.t.buy_count, [2, 4, 8]],
  ['minutes since 1st FOMO buy', (x) => (x.t.firstListedAt - x.t.first_buy) / 60, [30, 90, 240]],
  ['market cap', (x) => x.t.market_cap, [100e3, 300e3, 1e6, 5e6]],
  ['liquidity', (x) => x.t.liquidity, [25e3, 60e3, 150e3]],
  ['24h price change %', (x) => x.t.price_change_24h, [0, 50, 200]],
  ['buyers 30d realized PnL', (x) => x.t.buyer_realized_pnl_30d, [50e3, 150e3, 400e3]],
  ['also on Tokens page', (x) => (x.t.onTokensPage ? 1 : 0), [1]],
  ['last-hour share of 24h vol', (x) => vol1hShare(x.tr), [0.2, 0.4, 0.63]],
  ['run-up from 24h low (x)', (x) => run24(x.tr), [2, 5, 15]],
]
console.log('\nA) by what was known at first listing (2x / -70% per $100; 3x rate = peak >= 3x within 72h)')
for (const [name, get, edges] of feats) {
  console.log(`  ${name}`)
  for (let k = 0; k <= edges.length; k++) {
    const lo = k === 0 ? -Infinity : edges[k - 1], hi = k === edges.length ? Infinity : edges[k]
    const g = entries.filter((x) => { const v = get(x); return v >= lo && v < hi })
    if (!g.length) continue
    const per = g.reduce((a, x) => a + (simulate(x.tr, { name: '', tp: 2, sl: 0.3, maxHours: 72 }).mult * cost - 1) * 100, 0) / g.length
    const half = (pick: (x: { tr: Trade }) => boolean) => { const h = g.filter(pick); return h.length ? Math.round(h.reduce((a, x) => a + (simulate(x.tr, { name: '', tp: 2, sl: 0.3, maxHours: 72 }).mult * cost - 1) * 100, 0) / h.length) : NaN }
    const label = k === 0 ? `< ${edges[0]}` : k === edges.length ? `>= ${edges[k - 1]}` : `${edges[k - 1]}..${edges[k]}`
    console.log(`    ${label.padEnd(16)} n ${String(g.length).padStart(3)}   3x ${String(Math.round(g.filter((x) => peak(x.tr) >= 3).length / g.length * 100)).padStart(3)}%   per trade ${per >= 0 ? '+' : ''}${per.toFixed(1)}   (Oct 20-23 ${half((x) => x.tr.entryAt < SPLIT)}, Oct 24-27 ${half((x) => x.tr.entryAt >= SPLIT)})`)
  }
}
