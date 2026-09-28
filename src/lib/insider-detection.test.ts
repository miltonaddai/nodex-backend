import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  classifyPriceShape,
  collectLaunchActivity,
  insiderScore,
  insiderStatus,
  scoreLaunch,
  sharedFunderLinks,
  type LaunchTransaction,
} from './insider-detection'

const MINT = 'Mint111'
const POOL = 'Pool111'
const SUPPLY = 1_000_000_000

let sigCounter = 0

/** A launch transaction: `moves` maps owner → token delta (ui units), `sol` maps account → SOL delta. */
function tx(
  slot: number,
  feePayer: string,
  moves: Record<string, number>,
  sol: Record<string, number> = {}
): LaunchTransaction {
  const accounts = new Set([...Object.keys(moves), ...Object.keys(sol)])
  return {
    signature: `sig${sigCounter++}`,
    slot,
    timestamp: 1_000 + slot,
    feePayer,
    accountData: [...accounts].map((account) => ({
      account,
      nativeBalanceChange: Math.round((sol[account] ?? 0) * 1e9),
      tokenBalanceChanges:
        moves[account] === undefined
          ? []
          : [{ userAccount: account, mint: MINT, rawTokenAmount: { tokenAmount: String(moves[account] * 1e6), decimals: 6 } }],
    })),
  }
}

/** Pool noise so the pool crosses the infrastructure threshold. */
function poolNoise(count: number, startSlot: number): LaunchTransaction[] {
  return Array.from({ length: count }, (_, i) =>
    tx(startSlot + i, `retail${i}`, { [POOL]: -1_000_000, [`retail${i}`]: 1_000_000 }, { [`retail${i}`]: -0.1 })
  )
}

test('co-signed creation-block buys form one insider cluster', () => {
  const txs = [
    tx(100, 'A', { [POOL]: -120_000_000, A: 50_000_000, B: 40_000_000, C: 30_000_000 }, { A: -0.02, B: -0.02, C: -0.02 }),
    ...poolNoise(20, 101),
  ]
  const report = scoreLaunch(collectLaunchActivity(txs, MINT), [], SUPPLY)

  assert.equal(report.clusters.length, 1)
  assert.deepEqual(new Set(report.clusters[0].wallets), new Set(['A', 'B', 'C']))
  assert.ok(report.clusters[0].linkKinds.includes('co_signed'))
  assert.equal(report.creationBlockSupplyPct, 12)
  assert.equal(report.insiderAcquiredPct, 12)
  assert.ok(report.evidence.some((line) => line.includes('co-signed')))
})

test('transactions are ordered by slot before the creation block is measured', () => {
  const txs = [...poolNoise(20, 101), tx(100, 'A', { [POOL]: -10_000_000, A: 10_000_000 }, { A: -1 })]
  const activity = collectLaunchActivity(txs, MINT)

  assert.equal(activity.firstSlot, 100)
  assert.equal(activity.buyers.get('A')?.firstSlotOffset, 0)
  assert.equal(activity.buyers.get('retail0')?.firstSlotOffset, 1)
})

test('wallet-to-wallet transfers are splits, not buys', () => {
  const txs = [
    tx(100, 'A', { [POOL]: -50_000_000, A: 50_000_000 }, { A: -5 }),
    tx(105, 'A', { A: -20_000_000, Fresh: 20_000_000 }),
    ...poolNoise(20, 106),
  ]
  const activity = collectLaunchActivity(txs, MINT)
  const report = scoreLaunch(activity, [], SUPPLY)

  assert.equal(activity.buyers.get('Fresh')?.bought, 0)
  assert.equal(activity.buyers.get('Fresh')?.received, 20_000_000)
  assert.equal(report.splitTransfers, 1)
  assert.deepEqual(new Set(report.clusters[0].wallets), new Set(['A', 'Fresh']))
  // The split bag is not counted twice.
  assert.equal(report.insiderAcquiredPct, 5)
})

test('a relayer paying fees for many buyers is not an insider link', () => {
  const relayed = Array.from({ length: 5 }, (_, i) =>
    tx(110 + i, 'Relayer', { [POOL]: -1_000_000, [`user${i}`]: 1_000_000 })
  )
  const txs = [...relayed, ...poolNoise(20, 120)]
  const report = scoreLaunch(collectLaunchActivity(txs, MINT), [], SUPPLY)

  assert.equal(report.feePaidLinks, 0)
  assert.equal(report.clusters.length, 0)
})

test('a private wallet paying fees for a couple of buyers links them', () => {
  const txs = [
    tx(110, 'Boss', { [POOL]: -8_000_000, Mule1: 8_000_000 }),
    tx(111, 'Boss', { [POOL]: -8_000_000, Mule2: 8_000_000 }),
    ...poolNoise(20, 120),
  ]
  const report = scoreLaunch(collectLaunchActivity(txs, MINT), [], SUPPLY)

  assert.equal(report.feePaidLinks, 2)
  assert.ok(report.clusters[0].wallets.includes('Mule1'))
  assert.ok(report.clusters[0].wallets.includes('Mule2'))
})

test('shared funders count only when the funder is not an exchange or service', () => {
  const funders = new Map<string, string | null>([
    ['A', 'PrivateWhale'],
    ['B', 'PrivateWhale'],
    ['C', 'Exchange'],
    ['D', 'Exchange'],
  ])
  const links = sharedFunderLinks(funders, new Set(['Exchange']))

  assert.equal(links.length, 1)
  assert.deepEqual([links[0].a, links[0].b].sort(), ['A', 'B'])
})

test('price shape detects the dump-then-reclaim pattern', () => {
  const launch = 0
  const hour = 3600
  // Launch high $2M, low $600k, now $20M, with a supply of 1B.
  const series = [
    { unixTime: launch, value: 0.002 },
    { unixTime: launch + 8 * hour, value: 0.0006 },
    { unixTime: launch + 100 * hour, value: 0.02 },
  ]
  const shape = classifyPriceShape(series, SUPPLY, launch, 20_000_000)

  assert.equal(shape.pattern, 'reclaiming')
  assert.equal(Math.round(shape.launchHighMc), 2_000_000)
  assert.equal(Math.round(shape.postLaunchLowMc), 600_000)
})

test('price shape reports retracing while still under half the launch high', () => {
  const series = [
    { unixTime: 0, value: 0.002 },
    { unixTime: 3600 * 8, value: 0.0009 },
  ]
  assert.equal(classifyPriceShape(series, SUPPLY, 0, 900_000).pattern, 'retracing')
})

test('insider status and score reward insiders who still hold', () => {
  assert.equal(insiderStatus(0.5, 12), 'exited')
  assert.equal(insiderStatus(8, 12), 'holding')
  assert.equal(insiderStatus(4, 12), 'distributing')
  assert.ok(insiderScore(50, 10, 12) > insiderScore(50, 0.5, 12))
})

test('wallets flipping in and out of the launch are measured by net position', () => {
  const flips = Array.from({ length: 6 }, (_, i) => [
    tx(100 + i * 2, 'Flipper', { [POOL]: -300_000_000, Flipper: 300_000_000 }, { Flipper: -10 }),
    tx(101 + i * 2, 'Flipper', { [POOL]: 300_000_000, Flipper: -300_000_000 }, { Flipper: 10 }),
  ]).flat()
  const report = scoreLaunch(collectLaunchActivity([...flips, ...poolNoise(20, 120)], MINT), [], SUPPLY)

  assert.ok(report.launchSupplyPct <= 100, `launch supply ${report.launchSupplyPct}% exceeds 100%`)
})

test('an aggregator hop through an unsigned account is not a bag split', () => {
  const txs = [
    // Trader signs, tokens route through RouterPda, which the trader does not control.
    tx(110, 'Trader', { RouterPda: -5_000_000, Trader: 5_000_000 }, { Trader: -1 }),
    ...poolNoise(20, 120),
  ]
  const report = scoreLaunch(collectLaunchActivity(txs, MINT), [], SUPPLY)

  assert.equal(report.splitTransfers, 0)
  assert.equal(report.clusters.length, 0)
})

test('the launch window starts at the first token movement, not mint creation', () => {
  const txs = [
    tx(10, 'Creator', {}, { Creator: -0.02 }), // mint created, no trading yet
    tx(500, 'Sniper', { [POOL]: -10_000_000, Sniper: 10_000_000 }, { Sniper: -1 }),
    ...poolNoise(20, 501),
  ]
  const activity = collectLaunchActivity(txs, MINT, 120)

  assert.equal(activity.firstSlot, 500)
  assert.equal(activity.buyers.get('Sniper')?.firstSlotOffset, 0)
})

test('price pattern is unknown until the launch high has settled', () => {
  const series = [
    { unixTime: 0, value: 0.002 },
    { unixTime: 3600, value: 0.0006 },
  ]
  assert.equal(classifyPriceShape(series, SUPPLY, 0, 600_000).pattern, 'unknown')
})
