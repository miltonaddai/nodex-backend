import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assessRisk, type ScanFacts } from './token-risk'

const clean: ScanFacts = {
  liquidityUsd: 250_000,
  marketCapUsd: 2_000_000,
  ageHours: 48,
  mintAuthorityActive: false,
  freezeAuthorityActive: false,
  transferFeeBps: 0,
  transferFeeChangeable: false,
  permanentDelegate: false,
  contractVerified: null,
  holders: 3_000,
  uniqueWallets24h: 6_000,
  buys24h: 4_000,
  sells24h: 3_500,
  top10Pct: 15,
  largestHolderPct: 3,
  bundle: { insiderAcquiredPct: 1, insiderHoldingPct: 0, linkedWallets: 2 },
  smartMoneyBuyers: 4,
}

test('a clean token is favorable with positives listed', () => {
  const report = assessRisk(clean)
  assert.equal(report.verdict, 'favorable')
  assert.equal(report.flags.length, 0)
  assert.ok(report.positives.some((p) => p.title.includes('top traders')))
})

test('pulled liquidity is an automatic avoid', () => {
  const report = assessRisk({ ...clean, liquidityUsd: 0 })
  assert.equal(report.verdict, 'avoid')
  assert.equal(report.flags[0].severity, 'critical')
})

test('an active mint authority is an automatic avoid', () => {
  assert.equal(assessRisk({ ...clean, mintAuthorityActive: true }).verdict, 'avoid')
})

test('insiders still holding a bundled launch is flagged, exited insiders only noted', () => {
  const holding = assessRisk({ ...clean, bundle: { insiderAcquiredPct: 25, insiderHoldingPct: 18, linkedWallets: 30 } })
  assert.ok(holding.flags.some((f) => f.severity === 'high' && f.title.includes('still hold')))
  const exited = assessRisk({ ...clean, bundle: { insiderAcquiredPct: 17, insiderHoldingPct: 0, linkedWallets: 7 } })
  assert.ok(exited.flags.some((f) => f.severity === 'low'))
  assert.equal(exited.verdict, 'favorable')
})

test('bot-farm churn and concentration push toward caution or avoid', () => {
  const report = assessRisk({ ...clean, uniqueWallets24h: 3_000, top10Pct: 45, largestHolderPct: 12 })
  assert.equal(report.verdict, 'avoid')
  assert.ok(report.flags.some((f) => f.title.includes('Bot-farm')))
})

test('a market cap wildly above liquidity is flagged as mispriced', () => {
  // Seen on the insider table: $3.6B market cap on $5.5M liquidity.
  const report = assessRisk({ ...clean, marketCapUsd: 3_644_155_437, liquidityUsd: 5_497_015 })
  assert.ok(report.flags.some((f) => f.title.includes('does not match')))
})

test('flags are ordered from most to least severe', () => {
  const report = assessRisk({ ...clean, liquidityUsd: 0, top10Pct: 30, ageHours: 0.5 })
  const order = ['critical', 'high', 'medium', 'low']
  const ranks = report.flags.map((f) => order.indexOf(f.severity))
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b))
})

test('a transfer fee that can still be raised is flagged high', () => {
  // Super Inu: 1% fee, and a fee authority is still set.
  const report = assessRisk({ ...clean, transferFeeBps: 100, transferFeeChangeable: true })
  assert.ok(report.flags.some((f) => f.title === '1% transfer fee' && f.severity === 'medium'))
  assert.ok(report.flags.some((f) => f.title === 'Transfer fee can be raised' && f.severity === 'high'))
})
