/**
 * Backtests auto-buying every tokens-page token at the moment the scanner first saw it.
 * Reads the cache written by fetch-candles.ts. No API calls.
 *
 * Execution is deliberately pessimistic: entry at the open of the first 15m candle after
 * discovery, a fee + slippage charge on each side, stop checked before target when one candle
 * spans both, and gaps through the stop fill at the open.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TokenMeta } from './fetch-candles'

const DIR = process.env.BACKTEST_DIR ?? join(__dirname, 'data')
export const SPLIT = Date.parse('2026-10-15T00:00:00Z') / 1000
const STAKE = 100

interface Candle { t: number; o: number; h: number; l: number; c: number; v: number }

interface Trade {
  token: TokenMeta
  entryAt: number
  entry: number
  path: Candle[]
  /** Candles before entry (up to 24h). */
  pre: Candle[]
  /** Leak-free context: only candles before entry. */
  f: {
    ret1h: number; ret6h: number; ret24h: number; offHigh24h: number; vol24h: number
    ageH: number; mc: number; hourUtc: number
  }
}

interface Rule {
  name: string
  tp?: number          // take-profit multiple, e.g. 2 = +100%
  sl?: number          // stop as a multiple, e.g. 0.7 = -30%
  maxHours?: number    // time stop
  trailArm?: number    // trailing stop arms at this multiple
  trailPct?: number    // and exits this far below the running high
  partialAt?: number   // sell half here, trail/hold the rest
}

function load(): Trade[] {
  const tokens: TokenMeta[] = (JSON.parse(readFileSync(join(DIR, 'tokens.json'), 'utf8')) as TokenMeta[]).filter((t) => t.chain === 'solana')
  const trades: Trade[] = []
  let noData = 0, badPrice = 0
  for (const token of tokens) {
    const file = join(DIR, 'candles', `${token.chain}-${token.contract}.json`)
    if (!existsSync(file)) { noData++; continue }
    const all: Candle[] = (JSON.parse(readFileSync(file, 'utf8')) as Candle[])
      .filter((c) => c.o > 0 && c.h > 0 && c.l > 0 && c.c > 0)
      .sort((a, b) => a.t - b.t)
    const i = all.findIndex((c) => c.t >= token.firstSeen)
    if (i < 0 || all.length - i < 2) { noData++; continue }
    const entry = all[i].o
    // Birdeye and Dexscreener should agree on the price at discovery; a big gap means bad data.
    if (token.firstPrice > 0 && (entry / token.firstPrice > 3 || entry / token.firstPrice < 1 / 3)) { badPrice++; continue }
    const before = all.slice(0, i)
    const closeAt = (secsBack: number) => {
      const c = [...before].reverse().find((x) => x.t <= all[i].t - secsBack)
      return c ? c.c : before[0]?.o ?? entry
    }
    const last24 = before.filter((c) => c.t >= all[i].t - 86_400)
    const high24 = Math.max(entry, ...last24.map((c) => c.h))
    trades.push({
      token, entryAt: all[i].t, entry, path: all.slice(i), pre: before,
      f: {
        ret1h: entry / closeAt(3_600) - 1,
        ret6h: entry / closeAt(6 * 3_600) - 1,
        ret24h: entry / closeAt(86_400) - 1,
        offHigh24h: entry / high24 - 1,
        vol24h: last24.reduce((s, c) => s + c.v, 0),
        ageH: token.launchedAt > 0 ? (token.firstSeen - token.launchedAt) / 3_600 : -1,
        mc: token.firstMc,
        hourUtc: new Date(token.firstSeen * 1000).getUTCHours(),
      },
    })
  }
  console.log(`loaded ${trades.length} trades (${noData} no candles, ${badPrice} price mismatch)`)
  return trades
}

/** Gross exit multiple (before costs) for one trade under one rule. */
function simulate(tr: Trade, r: Rule): { mult: number; hours: number; reason: string } {
  const e = tr.entry
  let high = e
  let soldHalf = false
  let banked = 0 // multiple already realised on a partial sale, weighted 0.5
  const finish = (px: number, t: number, reason: string) => {
    const rest = soldHalf ? 0.5 : 1
    return { mult: banked + rest * (px / e), hours: (t - tr.entryAt) / 3600, reason }
  }
  for (const c of tr.path) {
    if (r.maxHours && c.t - tr.entryAt >= r.maxHours * 3600) return finish(c.o, c.t, 'time')
    // Stops first (pessimistic), including the trailing stop from the prior high.
    const trailLevel = r.trailArm && r.trailPct && high >= e * r.trailArm ? high * (1 - r.trailPct) : 0
    const stopLevel = Math.max(r.sl ? e * r.sl : 0, trailLevel)
    if (stopLevel > 0 && c.l <= stopLevel) return finish(Math.min(c.o, stopLevel), c.t, trailLevel >= stopLevel ? 'trail' : 'stop')
    if (r.partialAt && !soldHalf && c.h >= e * r.partialAt) {
      soldHalf = true
      banked = 0.5 * Math.max(c.o, e * r.partialAt) / e
    }
    if (r.tp && c.h >= e * r.tp) return finish(Math.max(c.o, e * r.tp), c.t, 'target')
    high = Math.max(high, c.h)
  }
  const last = tr.path[tr.path.length - 1]
  return finish(last.c, last.t, 'open')
}

function evaluate(trades: Trade[], r: Rule, costPerSide: number) {
  const nets = trades.map((tr) => {
    const s = simulate(tr, r)
    return { ...s, net: s.mult * (1 - costPerSide) * (1 - costPerSide) - 1 }
  })
  const pnl = nets.reduce((a, n) => a + n.net * STAKE, 0)
  const wins = nets.filter((n) => n.net > 0).length
  const sorted = nets.map((n) => n.net).sort((a, b) => a - b)
  // Profit with the 5 best trades removed: does the edge survive without its lottery tickets?
  const ex5 = sorted.slice(0, Math.max(0, sorted.length - 5)).reduce((a, n) => a + n * STAKE, 0)
  return {
    rule: r.name, n: trades.length, pnl: Math.round(pnl), perTrade: +(pnl / Math.max(1, trades.length)).toFixed(2),
    winRate: +(wins / Math.max(1, trades.length) * 100).toFixed(1), medianNet: +((sorted[Math.floor(sorted.length / 2)] ?? 0) * 100).toFixed(1),
    pnlEx5: Math.round(ex5),
  }
}

function rules(): Rule[] {
  const out: Rule[] = [{ name: 'hold to now' }]
  for (const h of [1, 2, 4, 12, 24, 72]) out.push({ name: `exit after ${h}h`, maxHours: h })
  for (const tp of [1.3, 1.5, 2, 3, 5])
    for (const sl of [0.5, 0.7, 0.8, 0.9, undefined])
      for (const maxHours of [24, 72, undefined])
        out.push({ name: `tp ${tp}x sl ${sl ?? '-'} max ${maxHours ?? '-'}h`, tp, sl, maxHours })
  for (const arm of [1.2, 1.5, 2])
    for (const trail of [0.2, 0.3, 0.4])
      for (const sl of [0.7, 0.8])
        out.push({ name: `trail arm ${arm}x ${trail * 100}% sl ${sl}`, trailArm: arm, trailPct: trail, sl })
  for (const p of [1.5, 2]) out.push({ name: `half at ${p}x, trail 30% sl 0.7`, partialAt: p, trailArm: p, trailPct: 0.3, sl: 0.7 })
  return out
}

function pct(xs: number[], q: number) {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]
}

function main() {
  const trades = load()
  const COST = 0.015
  const report: Record<string, unknown> = {}

  // What the price path actually looks like after discovery.
  const peak = (tr: Trade, hours?: number) =>
    Math.max(...tr.path.filter((c) => !hours || c.t - tr.entryAt < hours * 3600).map((c) => c.h)) / tr.entry
  const trough = (tr: Trade, hours: number) =>
    Math.min(...tr.path.filter((c) => c.t - tr.entryAt < hours * 3600).map((c) => c.l)) / tr.entry
  const peaks = trades.map((t) => peak(t))
  report.shape = {
    n: trades.length,
    peakMedian: pct(peaks, 0.5), peakP75: pct(peaks, 0.75), peakP90: pct(peaks, 0.9),
    reached: Object.fromEntries([1.3, 1.5, 2, 3, 5, 10].map((m) => [`${m}x`, +(peaks.filter((p) => p >= m).length / trades.length * 100).toFixed(1)])),
    reached2xBeforeMinus30: +(trades.filter((tr) => {
      for (const c of tr.path) { if (c.l <= tr.entry * 0.7) return false; if (c.h >= tr.entry * 2) return true }
      return false
    }).length / trades.length * 100).toFixed(1),
    worstIn24hMedian: pct(trades.map((t) => trough(t, 24)), 0.5),
    nowMedian: pct(trades.map((t) => t.path[t.path.length - 1].c / t.entry), 0.5),
    hoursToPeakMedian: pct(trades.map((t) => {
      const p = peak(t); return (t.path.find((c) => c.h / t.entry >= p)!.t - t.entryAt) / 3600
    }), 0.5),
  }

  const all = rules()
  const train = trades.filter((t) => t.entryAt < SPLIT)
  const test = trades.filter((t) => t.entryAt >= SPLIT)
  const full = all.map((r) => evaluate(trades, r, COST)).sort((a, b) => b.pnl - a.pnl)
  report.fullTop = full.slice(0, 12)
  report.fullBaselines = full.filter((x) => x.rule === 'hold to now' || x.rule.startsWith('exit after'))
  const trainRank = all.map((r) => ({ r, ...evaluate(train, r, COST) })).sort((a, b) => b.pnl - a.pnl)
  report.trainTop5ThenTest = trainRank.slice(0, 5).map((x) => ({
    rule: x.rule, train: { n: x.n, pnl: x.pnl, perTrade: x.perTrade, winRate: x.winRate },
    test: evaluate(test, x.r, COST), testStressCost3pct: evaluate(test, x.r, 0.03),
  }))

  // Filters on leak-free entry context, scored with one fixed exit so the filter is what varies.
  const exit: Rule = { name: 'tp 2x sl 0.7', tp: 2, sl: 0.7 }
  const buckets: Array<[string, (t: Trade) => number, number[]]> = [
    ['ret1h', (t) => t.f.ret1h, [-0.2, 0, 0.2, 0.5]],
    ['ret6h', (t) => t.f.ret6h, [-0.3, 0, 0.3, 1]],
    ['ret24h', (t) => t.f.ret24h, [-0.5, 0, 1, 3]],
    ['offHigh24h', (t) => t.f.offHigh24h, [-0.6, -0.4, -0.2, -0.05]],
    ['vol24h', (t) => t.f.vol24h, [50e3, 200e3, 1e6, 5e6]],
    ['ageH', (t) => t.f.ageH, [6, 24, 72, 168]],
    ['mc', (t) => t.f.mc, [100e3, 300e3, 1e6, 5e6]],
    ['hourUtc', (t) => t.f.hourUtc, [6, 12, 18]],
  ]
  report.features = Object.fromEntries(buckets.map(([name, get, edges]) => {
    const groups: Record<string, Trade[]> = {}
    for (const t of trades) {
      const v = get(t)
      let k = 0
      while (k < edges.length && v >= edges[k]) k++
      const label = k === 0 ? `< ${edges[0]}` : k === edges.length ? `>= ${edges[k - 1]}` : `${edges[k - 1]}..${edges[k]}`
      ;(groups[label] ??= []).push(t)
    }
    return [name, Object.fromEntries(Object.entries(groups).map(([label, g]) => {
      const tr = g.filter((t) => t.entryAt < SPLIT), te = g.filter((t) => t.entryAt >= SPLIT)
      return [label, {
        n: g.length, hit2x: +(g.filter((t) => peak(t) >= 2).length / g.length * 100).toFixed(0),
        perTrade: evaluate(g, exit, COST).perTrade, trainPer: evaluate(tr, exit, COST).perTrade, testPer: evaluate(te, exit, COST).perTrade,
        nTrain: tr.length, nTest: te.length,
      }]
    }))]
  }))

  
  writeFileSync(join(DIR, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 1))
}

if (require.main === module) main()
export { load, simulate, evaluate, rules, type Trade, type Rule, type Candle }
