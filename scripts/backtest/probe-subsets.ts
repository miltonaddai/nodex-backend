/** Stress-tests the few entry filters that looked positive in backtest.ts. */
import { evaluate, load, rules, simulate, SPLIT, type Trade } from './backtest'

const trades = load()
const subsets: Record<string, (t: Trade) => boolean> = {
  atHigh: (t) => t.f.offHigh24h >= -0.05,
  vol50to200k: (t) => t.f.vol24h >= 50e3 && t.f.vol24h < 200e3,
  ret6h_30to100: (t) => t.f.ret6h >= 0.3 && t.f.ret6h < 1,
  atHigh_and_vol: (t) => t.f.offHigh24h >= -0.05 && t.f.vol24h >= 50e3 && t.f.vol24h < 200e3,
}
const allRules = rules()
for (const [name, keep] of Object.entries(subsets)) {
  const g = trades.filter(keep)
  const res = allRules.map((r) => ({ r, all: evaluate(g, r, 0.015) })).sort((a, b) => b.all.pnl - a.all.pnl)
  const positive = res.filter((x) => x.all.pnl > 0).length
  console.log(`\n== ${name} n=${g.length}  rules profitable: ${positive}/${allRules.length}`)
  for (const x of [...res.slice(0, 3), res.find((x) => x.r.name === 'tp 2x sl 0.7 max -h')!]) {
    const tr = evaluate(g.filter((t) => t.entryAt < SPLIT), x.r, 0.015), te = evaluate(g.filter((t) => t.entryAt >= SPLIT), x.r, 0.015)
    console.log(`  ${x.r.name.padEnd(34)} pnl ${x.all.pnl} per ${x.all.perTrade} win ${x.all.winRate}% ex-top5 ${x.all.pnlEx5} | train ${tr.perTrade} test ${te.perTrade} | 3% cost ${evaluate(g, x.r, 0.03).perTrade}`)
  }
  // Bootstrap: how often does a resample of these trades lose money with tp2/sl0.7?
  const r = allRules.find((x) => x.name === 'tp 2x sl 0.7 max -h')!
  const nets = g.map((t) => simulate(t, r).mult * 0.985 * 0.985 - 1)
  let losing = 0
  for (let b = 0; b < 2000; b++) {
    let s = 0
    for (let i = 0; i < nets.length; i++) s += nets[Math.floor(Math.random() * nets.length)]
    if (s < 0) losing++
  }
  console.log(`  bootstrap P(loss) tp2/sl0.7: ${(losing / 20).toFixed(0)}%`)
}
