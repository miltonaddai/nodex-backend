/** How long trades lasted under the volume-surge rule (vol1hShare >= 0.63, mc < $120K). */
import { load, simulate, type Trade } from './backtest'

const vol1hShare = (t: Trade) => {
  const pre = t.pre.filter((c) => c.t >= t.entryAt - 86_400)
  const v24 = pre.reduce((a, c) => a + c.v, 0)
  return pre.filter((c) => c.t >= t.entryAt - 3600).reduce((a, c) => a + c.v, 0) / Math.max(1, v24)
}
const g = load().filter((t) => vol1hShare(t) >= 0.63 && t.f.mc < 120e3)

function closeConfirmed(t: Trade, tp: number, sl: number) {
  for (const c of t.path) {
    const hours = (c.t - t.entryAt) / 3600
    if (c.l <= t.entry * sl) return { hours, reason: 'stop' }
    if (c.c >= t.entry * tp) return { hours, reason: 'target' }
  }
  return { hours: (t.path[t.path.length - 1].t - t.entryAt) / 3600, reason: 'open' }
}
const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(p * (s.length - 1))] ?? 0 }
const fmt = (h: number) => (h < 1 ? `${Math.round(h * 60)}m` : `${h.toFixed(1)}h`)

function report(label: string, exits: Array<{ hours: number; reason: string }>) {
  console.log(`\n${label} (n ${exits.length})`)
  for (const reason of ['target', 'stop', 'trail', 'time', 'open']) {
    const hs = exits.filter((e) => e.reason === reason).map((e) => e.hours)
    if (!hs.length) continue
    console.log(`  ${reason.padEnd(7)} ${String(hs.length).padStart(3)}  mean ${fmt(hs.reduce((a, h) => a + h, 0) / hs.length).padStart(6)}  median ${fmt(q(hs, 0.5)).padStart(6)}  p25 ${fmt(q(hs, 0.25)).padStart(6)}  p75 ${fmt(q(hs, 0.75)).padStart(6)}`)
  }
  const closed = exits.filter((e) => e.reason !== 'open').map((e) => e.hours)
  console.log(`  closed trades: mean ${fmt(closed.reduce((a, h) => a + h, 0) / closed.length)}, median ${fmt(q(closed, 0.5))}`)
}
report('TP 2x / stop -30% (fills at the touch)', g.map((t) => simulate(t, { name: '', tp: 2, sl: 0.7 })))
report('TP 3x / stop -40%, close-confirmed', g.map((t) => closeConfirmed(t, 3, 0.6)))
