/** How often a 10% moonbag kept at the 2x target reaches 10x+, and what bag rules capture it. */
import { load, type Trade } from './backtest'

const COST = 0.015
const vol1hShare = (t: Trade) => {
  const pre = t.pre.filter((c) => c.t >= t.entryAt - 86_400)
  const v24 = pre.reduce((a, c) => a + c.v, 0)
  return pre.filter((c) => c.t >= t.entryAt - 3600).reduce((a, c) => a + c.v, 0) / Math.max(1, v24)
}
const trades = load().filter((t) => vol1hShare(t) >= 0.63 && t.f.mc < 120e3)

// Winners: hit 2x before -30%. Keep the candles after the 2x fill, in multiples of entry.
const winners: { sym: string; rest: { h: number; l: number; c: number; o: number; t: number }[]; at: number }[] = []
for (const t of trades) {
  for (let i = 0; i < t.path.length; i++) {
    const c = t.path[i]
    if (c.l <= t.entry * 0.7) break
    if (c.h >= t.entry * 2) {
      winners.push({ sym: t.token.symbol, at: c.t, rest: t.path.slice(i + 1).map((x) => ({ t: x.t, o: x.o / t.entry, h: x.h / t.entry, l: x.l / t.entry, c: x.c / t.entry })) })
      break
    }
  }
}
const peaks = winners.map((w) => ({ sym: w.sym, peak: Math.max(2, ...w.rest.map((c) => c.h)), hours: (() => {
  const p = Math.max(2, ...w.rest.map((c) => c.h)); const c = w.rest.find((x) => x.h >= p); return c ? (c.t - w.at) / 3600 : 0 })() }))
console.log(`${winners.length} trades hit 2x. Peak after the 2x sell:`)
for (const m of [3, 5, 10, 20]) console.log(`  reached ${m}x+: ${peaks.filter((p) => p.peak >= m).length}`)
console.log('  10x+ runners:', peaks.filter((p) => p.peak >= 10).map((p) => `${p.sym} peak ${p.peak.toFixed(1)}x after ${p.hours.toFixed(1)}h`).join(', ') || 'none')

// Bag rules for the kept 10%. Returns the bag's exit multiple vs entry.
type Rule = [string, (r: (typeof winners)[0]['rest']) => number]
const last = (r: (typeof winners)[0]['rest']) => (r.length ? r[r.length - 1].c : 2)
const tpWithStop = (tp: number, sl: number) => (r: (typeof winners)[0]['rest']) => {
  for (const c of r) { if (c.l <= sl) return Math.min(c.o, sl); if (c.h >= tp) return Math.max(c.o, tp) }
  return last(r)
}
const rules: Rule[] = [
  ['sell all at 2x (current)', () => 0],
  ['10x target, no stop', tpWithStop(10, 0)],
  ['10x target, stop at entry', tpWithStop(10, 1)],
  ['10x target, stop at 0.5x', tpWithStop(10, 0.5)],
  ['10x target, stop at 0.3x', tpWithStop(10, 0.3)],
  ['trail 50% from peak (no target)', (r) => { let pk = 2; for (const c of r) { if (c.l <= pk * 0.5) return Math.min(c.o, pk * 0.5); pk = Math.max(pk, c.h) } return last(r) }],
  ['trail 70% from peak (no target)', (r) => { let pk = 2; for (const c of r) { if (c.l <= pk * 0.3) return Math.min(c.o, pk * 0.3); pk = Math.max(pk, c.h) } return last(r) }],
]
const base = winners.length * 100 * (2 * (1 - COST) ** 2 - 1) // the 44 winners' profit when selling 100%
console.log('\nOn the 44 winners only ($100 per trade; losers are identical under every rule):')
for (const [name, f] of rules) {
  const keep = name.startsWith('sell all') ? 0 : 0.1
  const nets = winners.map((w) => ((1 - keep) * 2 + keep * f(w.rest)) * (1 - COST) ** 2 - 1)
  const pnl = nets.reduce((a, n) => a + n * 100, 0)
  const sorted = [...nets].sort((a, b) => a - b)
  const ex1 = sorted.slice(0, -1).reduce((a, n) => a + n * 100, 0)
  console.log(`  ${name.padEnd(32)} ${pnl - base >= 0 ? '+' : ''}${Math.round(pnl - base)} vs selling all   (without the single best runner: ${Math.round(ex1 - (winners.length - 1) * 100 * (2 * (1 - COST) ** 2 - 1)) >= 0 ? '+' : ''}${Math.round(ex1 - (winners.length - 1) * 100 * (2 * (1 - COST) ** 2 - 1))})`)
}

// Split-half check for the wide-stop bags (SPLIT = Oct 15)
const SPLIT_AT = Date.parse('2026-10-15T00:00:00Z') / 1000
for (const [name, f] of rules.filter(([n]) => /no stop|0\.5x|0\.3x/.test(n))) {
  const half = (pick: (w: (typeof winners)[0]) => boolean) =>
    Math.round(winners.filter(pick).reduce((a, w) => a + (0.1 * f(w.rest) - 0.1 * 2) * (1 - COST) ** 2 * 100, 0))
  console.log(`  ${name.padEnd(32)} Oct 1-14 ${half((w) => w.at < SPLIT_AT)}  Oct 15-27 ${half((w) => w.at >= SPLIT_AT)}`)
}
