/** Replays the volume-surge signals through a $100 account with fixed trade size and limited slots. */
import { load, simulate, type Trade } from './backtest'

const vol1hShare = (t: Trade) => {
  const pre = t.pre.filter((c) => c.t >= t.entryAt - 86_400)
  const v24 = pre.reduce((a, c) => a + c.v, 0)
  return pre.filter((c) => c.t >= t.entryAt - 3600).reduce((a, c) => a + c.v, 0) / Math.max(1, v24)
}
const sigs = load().filter((t) => vol1hShare(t) >= 0.63 && t.f.mc < 120e3).sort((a, b) => a.entryAt - b.entryAt)
const exits = sigs.map((t) => { const s = simulate(t, { name: '', tp: 2, sl: 0.7, maxHours: 72 }); return { t, end: t.entryAt + s.hours * 3600, net: s.mult * 0.985 ** 2 - 1 } })
for (const size of [10, 20, 25, 33]) for (const slots of [2, 3, 5]) {
  let cash = 100, open: { end: number; value: number }[] = [], taken = 0, low = 100
  for (const e of exits) {
    for (const o of open.filter((o) => o.end <= e.t.entryAt)) cash += o.value
    open = open.filter((o) => o.end > e.t.entryAt)
    low = Math.min(low, cash + open.length * size)
    if (open.length >= slots || cash < size) continue
    cash -= size; taken++; open.push({ end: e.end, value: size * (1 + e.net) })
  }
  const final = cash + open.reduce((a, o) => a + o.value, 0)
  console.log(`$${size}/trade ${slots} slots: trades ${taken}/${exits.length}, final $${final.toFixed(0)}, low ~$${low.toFixed(0)}`)
}
