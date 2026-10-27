/** Robustness check for the "early and hot" pattern found by patterns.ts. */
import { load, simulate, SPLIT, type Trade } from './backtest'

const trades = load()
const vol1hShare = (t: Trade) => {
  const pre = t.pre.filter((c) => c.t >= t.entryAt - 86_400)
  const v24 = pre.reduce((a, c) => a + c.v, 0)
  return pre.filter((c) => c.t >= t.entryAt - 3600).reduce((a, c) => a + c.v, 0) / Math.max(1, v24)
}
const closeConfirmed = (t: Trade, tp: number, sl: number) => {
  for (const c of t.path) {
    if (c.l <= t.entry * sl) return Math.min(c.o, t.entry * sl) / t.entry
    if (c.c >= t.entry * tp) return c.c / t.entry
  }
  return t.path[t.path.length - 1].c / t.entry
}
const cost = 0.985 ** 2
function row(label: string, g: Trade[]) {
  const stat = (xs: Trade[], f: (t: Trade) => number) => {
    const nets = xs.map((t) => f(t) * cost - 1).sort((a, b) => a - b)
    return { pnl: Math.round(nets.reduce((a, n) => a + n * 100, 0)), ex5: Math.round(nets.slice(0, -5).reduce((a, n) => a + n * 100, 0)) }
  }
  const tp2 = (t: Trade) => simulate(t, { name: '', tp: 2, sl: 0.7 }).mult
  const cc2 = (t: Trade) => closeConfirmed(t, 2, 0.7)
  const cc3 = (t: Trade) => closeConfirmed(t, 3, 0.6)
  const tr = g.filter((t) => t.entryAt < SPLIT), te = g.filter((t) => t.entryAt >= SPLIT)
  const p3 = g.filter((t) => Math.max(...t.path.filter((c) => c.t - t.entryAt < 72 * 3600).map((c) => c.h)) >= t.entry * 3).length
  console.log(`${label.padEnd(30)} n ${String(g.length).padStart(4)} 3x ${Math.round(p3 / Math.max(1, g.length) * 100)}% | tp2/sl30 ${JSON.stringify(stat(g, tp2))} tr ${stat(tr, tp2).pnl} te ${stat(te, tp2).pnl} | close-conf tp2/sl30 ${JSON.stringify(stat(g, cc2))} | close-conf tp3/sl40 ${JSON.stringify(stat(g, cc3))} tr ${stat(tr, cc3).pnl} te ${stat(te, cc3).pnl}`)
}
row('everything', trades)
for (const share of [0.4, 0.5, 0.63, 0.75])
  for (const mc of [80e3, 120e3, 200e3])
    row(`vol1hShare>=${share} mc<${mc / 1e3}k`, trades.filter((t) => vol1hShare(t) >= share && t.f.mc < mc))
for (const age of [1, 1.5, 2])
  for (const mc of [60e3, 80e3, 120e3])
    row(`age<${age}h mc<${mc / 1e3}k`, trades.filter((t) => t.f.ageH >= 0 && t.f.ageH < age && t.f.mc < mc))
