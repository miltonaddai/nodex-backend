/** Do the 5x exits in the low-volume subset survive requiring the candle to close near the target? */
import { evaluate, load, simulate, SPLIT, type Rule, type Trade } from './backtest'

const g = load().filter((t) => t.f.vol24h >= 50e3 && t.f.vol24h < 200e3)
const rule: Rule = { name: 'tp5 72h', tp: 5, maxHours: 72 }
let wick = 0, hits = 0
for (const t of g) {
  const c = t.path.find((c) => c.t - t.entryAt < 72 * 3600 && c.h >= t.entry * 5)
  if (c) { hits++; if (c.c < t.entry * 2.5) wick++ }
}
console.log(`5x hits ${hits}, of which the candle closed under 2.5x: ${wick}`)

// Close-confirmed version: exit only if a candle CLOSES at or above the target, at that close.
const closeConfirmed = (t: Trade, tp: number, hours: number) => {
  for (const c of t.path) {
    if (c.t - t.entryAt >= hours * 3600) return c.o / t.entry
    if (c.c >= t.entry * tp) return c.c / t.entry
  }
  return t.path[t.path.length - 1].c / t.entry
}
for (const tp of [2, 3, 5]) {
  const nets = g.map((t) => ({ t, n: closeConfirmed(t, tp, 72) * 0.985 ** 2 - 1 }))
  const sum = (xs: typeof nets) => Math.round(xs.reduce((a, x) => a + x.n * 100, 0))
  const sorted = nets.map((x) => x.n).sort((a, b) => a - b)
  console.log(`close-confirmed tp ${tp}x/72h: pnl ${sum(nets)} ex-top5 ${Math.round(sorted.slice(0, -5).reduce((a, n) => a + n * 100, 0))} train ${sum(nets.filter((x) => x.t.entryAt < SPLIT))} test ${sum(nets.filter((x) => x.t.entryAt >= SPLIT))}`)
}

// Day by day, $100 per trade, wick version.
const byDay: Record<string, { n: number; pnl: number }> = {}
for (const t of g) {
  const d = new Date(t.entryAt * 1000).toISOString().slice(5, 10)
  const net = simulate(t, rule).mult * 0.985 ** 2 - 1
  ;(byDay[d] ??= { n: 0, pnl: 0 }).n++
  byDay[d].pnl += net * 100
}
let cum = 0, peak = 0, dd = 0
for (const [d, v] of Object.entries(byDay).sort()) {
  cum += v.pnl; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak)
  console.log(d, String(v.n).padStart(3), Math.round(v.pnl).toString().padStart(6), 'cum', Math.round(cum))
}
console.log('max drawdown', Math.round(dd), evaluate(g, rule, 0.015))
