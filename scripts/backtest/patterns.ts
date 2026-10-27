/**
 * What did the tokens that went on to do multiples look like at the moment the scanner flagged
 * them? Every feature uses only data from before entry. Each feature is scored on the first and
 * second half of the month separately; a pattern only counts if it holds in both.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { load, simulate, SPLIT, type Candle, type Trade } from './backtest'

const DIR = process.env.BACKTEST_DIR ?? join(__dirname, 'data')
const ctx = JSON.parse(readFileSync(join(DIR, 'context.json'), 'utf8')) as {
  stats: Record<string, any>
  buyers: Record<string, any>
}

type Row = { t: Trade; big: boolean; clean: boolean; net2: number; net5: number; x: Record<string, number | null> }

const num = (v: unknown) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v))
const sum = (cs: Candle[], f: (c: Candle) => number) => cs.reduce((a, c) => a + f(c), 0)

function chart(t: Trade): Record<string, number | null> {
  const pre = t.pre.filter((c) => c.t >= t.entryAt - 86_400)
  const e = t.entry
  if (pre.length < 2) return { preCandles: pre.length }
  const hi = pre.reduce((m, c) => (c.h > m.h ? c : m), pre[0])
  const lo = Math.min(...pre.map((c) => c.l))
  const sinceHigh = pre.filter((c) => c.t > hi.t)
  const lowSinceHigh = sinceHigh.length ? Math.min(...sinceHigh.map((c) => c.l)) : e
  const last = (n: number) => pre.slice(-n)
  const closeBack = (secs: number) => [...pre].reverse().find((c) => c.t <= t.entryAt - secs)?.c ?? pre[0].o
  const l4 = last(4), l8 = last(8)
  const vol1h = sum(pre.filter((c) => c.t >= t.entryAt - 3600), (c) => c.v)
  const volPrev1h = sum(pre.filter((c) => c.t >= t.entryAt - 7200 && c.t < t.entryAt - 3600), (c) => c.v)
  const vol24 = sum(pre, (c) => c.v)
  let higherLows = 0
  for (let i = 1; i < l4.length; i++) if (l4[i].l > l4[i - 1].l) higherLows++
  return {
    runFromLow: e / lo,
    offHigh: e / hi.h - 1,
    minsSinceHigh: (t.entryAt - hi.t) / 60,
    pullbackDepth: lowSinceHigh / hi.h - 1,
    bounceOffLow: e / lowSinceHigh - 1,
    ret15m: e / closeBack(900) - 1,
    ret1h: e / closeBack(3600) - 1,
    ret3h: e / closeBack(3 * 3600) - 1,
    vol1h,
    volTrend: vol1h / Math.max(1, volPrev1h),
    vol1hShare: vol1h / Math.max(1, vol24),
    vol24,
    greenLast4: l4.filter((c) => c.c > c.o).length,
    higherLows,
    range1h: sum(l4, (c) => (c.h - c.l) / c.l) / l4.length,
    upperWick: sum(l8, (c) => (c.h - Math.max(c.o, c.c)) / Math.max(1e-12, c.h - c.l)) / l8.length,
    preCandles: pre.length,
    ageH: t.f.ageH,
    hourUtc: t.f.hourUtc,
  }
}

function tokenData(t: Trade): Record<string, number | null> {
  const s = ctx.stats[t.token.contract]
  const b = ctx.buyers[t.token.contract]
  const out: Record<string, number | null> = { mcAtSighting: t.token.firstMc }
  if (s) {
    const mc = num(s.mc) || num(s.fdv) || 0
    Object.assign(out, {
      liq: num(s.liq), liqToMc: mc ? num(s.liq)! / mc : null, holders: num(s.holders),
      volToMc: mc ? num(s.vol)! / mc : null, churn: num(s.churn), uniqueWallets: num(s.uw),
      buySellCount: num(s.sells) ? num(s.buys)! / num(s.sells)! : null,
      avgTradeUsd: num(s.trades) ? num(s.vol)! / num(s.trades)! : null,
      tradesPerWallet: num(s.uw) ? num(s.trades)! / num(s.uw)! : null,
      mcPerHolder: num(s.holders) ? mc / num(s.holders)! : null,
    })
  }
  if (b) {
    Object.assign(out, {
      buyers: num(b.buyers), sniperShare: num(b.sniperShare), top5BuyerShare: num(b.top5Share),
      avgBuyUsd: num(b.avgBuy), medBuyUsd: num(b.medBuy), bigBuys: num(b.bigBuys),
      washShare: num(b.washShare), suspiciousShare: num(b.suspShare), buyShareLast1h: num(b.buyShare1h),
      buyToSellUsd: num(b.sellUsd) ? num(b.buyUsd)! / num(b.sellUsd)! : null,
    })
  }
  return out
}

/** Mann-Whitney AUC: chance a random winner scores higher than a random loser. */
function auc(rows: Row[], f: string, label: (r: Row) => boolean): number | null {
  const xs = rows.filter((r) => r.x[f] !== null && r.x[f] !== undefined)
  const pos = xs.filter(label).map((r) => r.x[f]!), neg = xs.filter((r) => !label(r)).map((r) => r.x[f]!)
  if (pos.length < 8 || neg.length < 8) return null
  const all = [...pos.map((v) => [v, 1]), ...neg.map((v) => [v, 0])].sort((a, b) => a[0] - b[0])
  let rank = 0, rPos = 0
  for (let i = 0; i < all.length; ) {
    let j = i
    while (j < all.length && all[j][0] === all[i][0]) j++
    const avg = (i + j + 1) / 2
    for (let k = i; k < j; k++) if (all[k][1]) rPos += avg
    rank = j; i = j
  }
  return (rPos - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length)
}

function quantileEdges(vals: number[], q = 5): number[] {
  const s = [...vals].sort((a, b) => a - b)
  return [...new Set(Array.from({ length: q - 1 }, (_, i) => s[Math.floor(((i + 1) / q) * s.length)]))]
}

const describe = (g: Row[]) => ({
  n: g.length,
  big3x: Math.round((g.filter((r) => r.big).length / Math.max(1, g.length)) * 100),
  clean2x: Math.round((g.filter((r) => r.clean).length / Math.max(1, g.length)) * 100),
  perTrade_tp2sl70: +((g.reduce((a, r) => a + r.net2, 0) / Math.max(1, g.length)) * 100).toFixed(1),
  perTrade_tp5_72h: +((g.reduce((a, r) => a + r.net5, 0) / Math.max(1, g.length)) * 100).toFixed(1),
})

function main() {
  const cost = 0.985 ** 2
  const rows: Row[] = load().map((t) => {
    const peak72 = Math.max(...t.path.filter((c) => c.t - t.entryAt < 72 * 3600).map((c) => c.h)) / t.entry
    let clean = false
    for (const c of t.path) { if (c.l <= t.entry * 0.7) break; if (c.h >= t.entry * 2) { clean = true; break } }
    return {
      t, big: peak72 >= 3, clean,
      net2: simulate(t, { name: '', tp: 2, sl: 0.7 }).mult * cost - 1,
      net5: simulate(t, { name: '', tp: 5, maxHours: 72 }).mult * cost - 1,
      x: { ...chart(t), ...tokenData(t) },
    }
  })
  const train = rows.filter((r) => r.t.entryAt < SPLIT), test = rows.filter((r) => r.t.entryAt >= SPLIT)
  const features = [...new Set(rows.flatMap((r) => Object.keys(r.x)))]
  const report: any = { base: { all: describe(rows), train: describe(train), test: describe(test) }, features: [] }

  for (const f of features) {
    const have = rows.filter((r) => r.x[f] !== null && r.x[f] !== undefined)
    const a = { big: auc(have, f, (r) => r.big), clean: auc(have, f, (r) => r.clean) }
    const aTr = auc(train, f, (r) => r.big), aTe = auc(test, f, (r) => r.big)
    const edges = quantileEdges(have.map((r) => r.x[f]!))
    const buckets = Array.from({ length: edges.length + 1 }, (_, k) => {
      const lo = k === 0 ? -Infinity : edges[k - 1], hi = k === edges.length ? Infinity : edges[k]
      const inB = (r: Row) => r.x[f]! >= lo && r.x[f]! < hi
      return {
        range: `${lo === -Infinity ? '' : +lo.toPrecision(3)}..${hi === Infinity ? '' : +hi.toPrecision(3)}`,
        ...describe(have.filter(inB)),
        trainBig: describe(have.filter((r) => inB(r) && r.t.entryAt < SPLIT)).big3x,
        testBig: describe(have.filter((r) => inB(r) && r.t.entryAt >= SPLIT)).big3x,
      }
    })
    report.features.push({ f, n: have.length, aucBig: a.big, aucClean: a.clean, aucTrain: aTr, aucTest: aTe, buckets })
  }
  // Strongest first: distance of AUC from 0.5, only counting it when both halves agree in sign.
  const strength = (x: any) =>
    x.aucTrain === null || x.aucTest === null || Math.sign(x.aucTrain - 0.5) !== Math.sign(x.aucTest - 0.5)
      ? 0 : Math.min(Math.abs(x.aucTrain - 0.5), Math.abs(x.aucTest - 0.5))
  report.features.sort((a: any, b: any) => strength(b) - strength(a))

  // Two-feature rules: thresholds at the quintile edges, chosen on train, then shown on test.
  const top = report.features.slice(0, 14).map((x: any) => x.f)
  const conds: Array<{ name: string; ok: (r: Row) => boolean }> = []
  for (const f of top) {
    const have = rows.filter((r) => r.x[f] != null).map((r) => r.x[f]!)
    for (const e of quantileEdges(have)) {
      const v = +e.toPrecision(3)
      conds.push({ name: `${f} >= ${v}`, ok: (r) => r.x[f] != null && r.x[f]! >= e })
      conds.push({ name: `${f} < ${v}`, ok: (r) => r.x[f] != null && r.x[f]! < e })
    }
  }
  const combos: any[] = []
  for (let i = 0; i < conds.length; i++)
    for (let j = i; j < conds.length; j++) {
      const ok = (r: Row) => conds[i].ok(r) && (i === j || conds[j].ok(r))
      const tr = train.filter(ok)
      if (tr.length < 30) continue
      combos.push({ rule: i === j ? conds[i].name : `${conds[i].name} AND ${conds[j].name}`, ok, train: describe(tr) })
    }
  combos.sort((a, b) => b.train.big3x - a.train.big3x)
  report.combos = combos.slice(0, 25).map((c) => ({ rule: c.rule, train: c.train, test: describe(test.filter(c.ok)) }))
  report.combosTested = combos.length
  writeFileSync(join(DIR, 'patterns.json'), JSON.stringify(report, null, 1))

  console.log('BASE', JSON.stringify(report.base))
  for (const x of report.features.slice(0, 18)) {
    console.log(`\n${x.f}  n=${x.n}  AUC(3x) all ${x.aucBig?.toFixed(2)} train ${x.aucTrain?.toFixed(2)} test ${x.aucTest?.toFixed(2)} | AUC(clean2x) ${x.aucClean?.toFixed(2)}`)
    for (const b of x.buckets) console.log(`   ${b.range.padEnd(22)} n ${String(b.n).padStart(4)}  3x ${String(b.big3x).padStart(3)}% (tr ${b.trainBig} te ${b.testBig})  clean2x ${String(b.clean2x).padStart(3)}%  tp2/sl30 ${b.perTrade_tp2sl70}%  tp5/72h ${b.perTrade_tp5_72h}%`)
  }
  console.log(`\nWEAK/NO SIGNAL: ${report.features.slice(18).map((x: any) => `${x.f}(${x.aucBig?.toFixed(2)})`).join(' ')}`)
  console.log(`\nCOMBOS (${combos.length} tested, best by train 3x rate)`)
  for (const c of report.combos.slice(0, 15)) console.log(` ${c.rule}\n    train ${JSON.stringify(c.train)}\n    test  ${JSON.stringify(c.test)}`)
}

main()
