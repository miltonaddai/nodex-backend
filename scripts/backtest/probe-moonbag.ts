/**
 * "Moonbag" variant of the volume-surge rule (vol1hShare >= 0.63, mcap < $120K): at the 2x target sell
 * 90% and keep 10%, then manage the 10% with different rules. Losing trades still sell 100% at -30%.
 */
import { load, SPLIT, type Candle, type Trade } from './backtest'

const COST = 0.015 // per side, as in the original backtest
const vol1hShare = (t: Trade) => {
  const pre = t.pre.filter((c) => c.t >= t.entryAt - 86_400)
  const v24 = pre.reduce((a, c) => a + c.v, 0)
  return pre.filter((c) => c.t >= t.entryAt - 3600).reduce((a, c) => a + c.v, 0) / Math.max(1, v24)
}
const trades = load().filter((t) => vol1hShare(t) >= 0.63 && t.f.mc < 120e3)

type Bag = { name: string; exit: (rest: Candle[], e: number) => { mult: number } }
/** Remainder exits. `rest` = candles after the 2x fill; multiples are vs entry. */
const bags: Bag[] = [
  { name: 'sell 100% at 2x (current)', exit: () => ({ mult: 2 }) },
  { name: 'keep 10%: hold to today', exit: (rest) => ({ mult: rest.length ? rest[rest.length - 1].c : 2 }) },
  ...[1, 0.7].map((sl): Bag => ({
    name: `keep 10%: stop at ${sl === 1 ? 'entry (breakeven)' : '-30% from entry'}`,
    exit: (rest, e) => {
      for (const c of rest) if (c.l <= e * sl) return { mult: Math.min(c.o, e * sl) }
      return { mult: rest.length ? rest[rest.length - 1].c : 2 * e }
    },
  })),
  { name: 'keep 10%: trail 50% from peak', exit: (rest, e) => {
    let peak = 2 * e
    for (const c of rest) { if (c.l <= peak * 0.5) return { mult: Math.min(c.o, peak * 0.5) }; peak = Math.max(peak, c.h) }
    return { mult: rest.length ? rest[rest.length - 1].c : 2 * e }
  } },
  ...[5, 10].map((tp): Bag => ({
    name: `keep 10%: sell at ${tp}x, stop at entry`,
    exit: (rest, e) => {
      for (const c of rest) { if (c.l <= e) return { mult: Math.min(c.o, e) }; if (c.h >= e * tp) return { mult: Math.max(c.o, e * tp) } }
      return { mult: rest.length ? rest[rest.length - 1].c : 2 * e }
    },
  })),
]

/** Net return per $1 for one trade: 2x target / -30% stop on the whole position, then the bag rule. */
function run(t: Trade, bag: Bag, keep: number): number {
  const e = t.entry
  for (let i = 0; i < t.path.length; i++) {
    const c = t.path[i]
    if (c.l <= e * 0.7) return (Math.min(c.o, e * 0.7) / e) * (1 - COST) ** 2 - 1
    if (c.h >= e * 2) {
      const fill = Math.max(c.o, e * 2) / e
      const rest = t.path.slice(i + 1)
      const bagMult = keep > 0 ? bag.exit(rest.map((x) => ({ ...x, o: x.o / e, h: x.h / e, l: x.l / e, c: x.c / e })), 1).mult : 0
      return ((1 - keep) * fill + keep * bagMult) * (1 - COST) ** 2 - 1
    }
  }
  return (t.path[t.path.length - 1].c / e) * (1 - COST) ** 2 - 1
}

const stat = (nets: number[]) => {
  const s = [...nets].sort((a, b) => a - b)
  return { pnl: Math.round(s.reduce((a, n) => a + n * 100, 0)), ex5: Math.round(s.slice(0, -5).reduce((a, n) => a + n * 100, 0)) }
}
const winners = trades.filter((t) => run(t, bags[0], 0) > 0).length
console.log(`${trades.length} trades, ${winners} reached 2x before the stop\n`)
for (const keep of [0.1]) {
  for (const bag of bags) {
    const k = bag.name.startsWith('sell 100%') ? 0 : keep
    const all = stat(trades.map((t) => run(t, bag, k)))
    const tr = stat(trades.filter((t) => t.entryAt < SPLIT).map((t) => run(t, bag, k)))
    const te = stat(trades.filter((t) => t.entryAt >= SPLIT).map((t) => run(t, bag, k)))
    // What the kept 10% did on the winners: share that came back above the 2x level vs died
    console.log(`${bag.name.padEnd(36)} total ${String(all.pnl).padStart(6)}  w/o top 5 ${String(all.ex5).padStart(5)}  | Oct 1-14 ${String(tr.pnl).padStart(5)}  Oct 15-27 ${String(te.pnl).padStart(5)}`)
  }
}
// Distribution of what a held 10% was worth by today, on the winners
const finals = trades.flatMap((t) => {
  const e = t.entry
  for (let i = 0; i < t.path.length; i++) {
    const c = t.path[i]
    if (c.l <= e * 0.7) return []
    if (c.h >= e * 2) { const rest = t.path.slice(i + 1); return [rest.length ? rest[rest.length - 1].c / e : 2] }
  }
  return []
}).sort((a, b) => a - b)
const q = (p: number) => finals[Math.floor(p * (finals.length - 1))].toFixed(2)
console.log(`\nWinners' price today vs entry: median ${q(0.5)}x, 75th pct ${q(0.75)}x, 90th ${q(0.9)}x, max ${finals[finals.length - 1].toFixed(1)}x; ${finals.filter((x) => x >= 2).length}/${finals.length} still at or above 2x`)
