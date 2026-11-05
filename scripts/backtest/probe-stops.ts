/** Stop-loss width for the volume-surge rule (vol1hShare >= 0.63, mcap < $120K) with the 2x target. */
import { load, SPLIT, simulate, type Trade } from './backtest'

const vol1hShare = (t: Trade) => {
  const pre = t.pre.filter((c) => c.t >= t.entryAt - 86_400)
  const v24 = pre.reduce((a, c) => a + c.v, 0)
  return pre.filter((c) => c.t >= t.entryAt - 3600).reduce((a, c) => a + c.v, 0) / Math.max(1, v24)
}
const trades = load().filter((t) => vol1hShare(t) >= 0.63 && t.f.mc < 120e3)
const cost = 0.985 ** 2

console.log('stop    wins  avg loss  avg hold   total   w/o top 5   Oct 1-14  Oct 15-27  stopped then hit 2x later')
for (const stopPct of [20, 30, 40, 50, 60, 70]) {
  const rule = { name: '', tp: 2, sl: 1 - stopPct / 100, maxHours: 72 }
  const res = trades.map((t) => ({ t, s: simulate(t, rule) })).map(({ t, s }) => ({ t, net: s.mult * cost - 1, hours: s.hours, reason: s.reason }))
  const sum = (xs: typeof res) => Math.round(xs.reduce((a, r) => a + r.net * 100, 0))
  const sorted = res.map((r) => r.net).sort((a, b) => a - b)
  const losses = res.filter((r) => r.net <= 0)
  // Trades this stop sold that would have reached 2x had the stop been wider (the "room" being paid for)
  const shaken = res.filter((r) => r.reason === 'stop' && simulate(r.t, { name: '', tp: 2 }).reason === 'target').length
  console.log(
    `-${stopPct}%`.padEnd(8) +
    `${res.filter((r) => r.net > 0).length}`.padEnd(6) +
    `${(losses.reduce((a, r) => a + r.net, 0) / Math.max(1, losses.length) * 100).toFixed(0)}%`.padEnd(10) +
    `${(res.reduce((a, r) => a + r.hours, 0) / res.length).toFixed(1)}h`.padEnd(11) +
    `${sum(res)}`.padEnd(8) +
    `${Math.round(sorted.slice(0, -5).reduce((a, n) => a + n * 100, 0))}`.padEnd(12) +
    `${sum(res.filter((r) => r.t.entryAt < SPLIT))}`.padEnd(10) +
    `${sum(res.filter((r) => r.t.entryAt >= SPLIT))}`.padEnd(11) +
    `${shaken}`
  )
}

// Replay through a $100 account: $20 per trade, max 3 open (SurgeBot defaults), in time order
console.log('\n$100 account, $20/trade, 3 slots:')
console.log('stop    taken  final   worst drop from a high   longest losing streak')
for (const stopPct of [30, 40, 50, 60, 70]) {
  const rule = { name: '', tp: 2, sl: 1 - stopPct / 100, maxHours: 72 }
  const ex = trades.map((t) => { const s = simulate(t, rule); return { start: t.entryAt, end: t.entryAt + s.hours * 3600, net: s.mult * cost - 1 } }).sort((a, b) => a.start - b.start)
  let cash = 100, open: { end: number; value: number }[] = [], taken = 0
  const closes: { at: number; pnl: number }[] = []
  for (const e of ex) {
    for (const o of open.filter((o) => o.end <= e.start)) cash += o.value
    open = open.filter((o) => o.end > e.start)
    if (open.length >= 3 || cash < 20) continue
    cash -= 20; taken++; open.push({ end: e.end, value: 20 * (1 + e.net) }); closes.push({ at: e.end, pnl: 20 * e.net })
  }
  const final = cash + open.reduce((a, o) => a + o.value, 0)
  closes.sort((a, b) => a.at - b.at)
  let eq = 100, peak = 100, dd = 0, streak = 0, worst = 0
  for (const c of closes) { eq += c.pnl; peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak); streak = c.pnl < 0 ? streak + 1 : 0; worst = Math.max(worst, streak) }
  console.log(`-${stopPct}%`.padEnd(8) + `${taken}`.padEnd(7) + `$${final.toFixed(0)}`.padEnd(8) + `-$${(-dd).toFixed(0)}`.padEnd(25) + `${worst}`)
}
