import assert from 'node:assert/strict'
import test from 'node:test'
import {
  aggregateTokenPerformance,
  scoreToken,
  scoreWallet,
  scoreWalletReputation,
  type TokenDemandInput,
  type TokenPerformance,
  type TokenScoreInput,
} from './alpha-scoring'
import { evaluateTokenSafety } from './token-safety'
import { isFreshWallet, isIndependentBuyer, isRealBuyer } from './wallet-quality'

test('aggregates realized and mark-to-market launch performance', () => {
  const performance = aggregateTokenPerformance('mint', 1_000, 2, [
    {
      side: 'buy',
      tokenAmount: 100,
      quoteUsd: 100,
      blockTime: 1_060,
      minutesAfterLaunch: 1,
      suspicious: false,
    },
    {
      side: 'sell',
      tokenAmount: 50,
      quoteUsd: 100,
      blockTime: 2_000,
      minutesAfterLaunch: 16,
      suspicious: false,
    },
  ])

  assert.ok(performance)
  assert.equal(performance.realizedPnl, 50)
  assert.equal(performance.unrealizedPnl, 50)
  assert.equal(performance.roiPct, 100)
})

test('requires repeat evidence before assigning a smart score', () => {
  const one = aggregateTokenPerformance('a', 1_000, 2, [
    {
      side: 'buy',
      tokenAmount: 100,
      quoteUsd: 100,
      blockTime: 1_060,
      minutesAfterLaunch: 1,
      suspicious: false,
    },
  ])
  assert.ok(one)
  assert.equal(scoreWallet([one], 3).smartScore, 0)
  const eligible = scoreWallet(
    [one, { ...one, contract: 'b' }, { ...one, contract: 'c' }],
    3,
    0,
    0
  )
  assert.equal(eligible.eligible, true)
  assert.ok(eligible.smartScore > 0)
})

test('rejects wallets that lose money inside the selected period', () => {
  const losing = {
    contract: 'a',
    launchedAt: 1_000,
    firstBuyAt: 1_060,
    lastTradeAt: 2_000,
    entryDelayMinutes: 1,
    buyUsd: 1_000,
    sellUsd: 100,
    boughtAmount: 100,
    soldAmount: 100,
    remainingAmount: 0,
    realizedPnl: -900,
    unrealizedPnl: 0,
    roiPct: -90,
    tradeCount: 2,
    suspiciousTradeCount: 0,
  }
  const scored = scoreWallet(
    [losing, { ...losing, contract: 'b' }, { ...losing, contract: 'c' }],
    3,
    100,
    5
  )
  assert.equal(scored.eligible, false)
  assert.equal(scored.smartScore, 0)
  assert.ok(scored.riskFlags.includes('unprofitable_in_period'))
})

const closedWin: TokenPerformance = {
  contract: 'past-a',
  launchedAt: 1_000,
  firstBuyAt: 1_060,
  lastTradeAt: 2_000,
  entryDelayMinutes: 20,
  buyUsd: 1_000,
  sellUsd: 1_800,
  boughtAmount: 100,
  soldAmount: 100,
  remainingAmount: 0,
  realizedPnl: 800,
  unrealizedPnl: 0,
  roiPct: 80,
  tradeCount: 4,
  suspiciousTradeCount: 0,
}

const healthyDemand: TokenDemandInput = {
  realBuyers: 240,
  independentBuyers: 6,
  netInflowUsd: 40_000,
  reputationWeightedInflow: 24_000,
  retentionRate: 0.75,
  demandPersistence: 0.8,
  topBuyerShare: 0.3,
  sniperShare: 0.1,
  washRatio: 0.05,
  freshBuyerShare: 0.1,
  enrichedHolders: 10,
  wealthyHolders: 6,
}

const healthyToken: TokenScoreInput = {
  ageDays: 2,
  liquidity: 100_000,
  // 240 buyers against this cap is ~$2.1k each, in line with the observed p50 of ~$3.5k.
  marketCap: 500_000,
  evidenceTier: 'verified',
  safetyFailed: false,
  buyAcceleration: 1.5,
  minRealBuyers: 100,
  demand: healthyDemand,
}

const safeMarket = {
  liquidity: 100_000,
  marketCap: 500_000,
  fdv: 550_000,
  volume24h: 250_000,
  pairCount: 3,
  marketHealthy: true,
  marketHealthFresh: true,
  distinctBuyers: 120,
  distinctSellers: 60,
  sniperShare: 0.1,
  topBuyerShare: 0.3,
  washRatio: 0.05,
}

test('scores a healthy token with real independent demand', () => {
  const scored = scoreToken(healthyToken)
  assert.equal(scored.scored, true)
  assert.ok(scored.alphaScore > 40)
})

/**
 * Regression test for the v1 defect that made the Tokens page permanently empty.
 *
 * v1 required buyers to clear a `smart_score` threshold, but that score was computed from
 * realized profit — i.e. from selling. A wallet with a strong track record is, by construction,
 * a net seller historically, so it could never also be counted as a net buyer. Qualified buyers
 * was therefore always 0 and every token scored 0.
 *
 * Reputation must describe past exits while demand describes current accumulation, so a wallet
 * with a profitable (net-selling) history must still count as a real buyer today.
 */
test('a wallet with a profitable selling history still counts as a real buyer', () => {
  const reputation = scoreWalletReputation([closedWin, { ...closedWin, contract: 'past-b' }])
  assert.ok(
    reputation.reputationScore > 0,
    'a wallet that sold at a profit should have positive reputation'
  )

  const buyer = {
    tags: [],
    netFlowUsd: 5_000,
    isFresh: false,
    isSniper: false,
    distinctOtherTokens: 4,
    washRatio: 0,
  }
  assert.equal(isRealBuyer(buyer), true)
  assert.equal(isIndependentBuyer(buyer), true)
})

test('reputation ignores the token being scored (out-of-sample)', () => {
  const history = [closedWin, { ...closedWin, contract: 'past-b' }, { ...closedWin, contract: 'target' }]
  const withTarget = scoreWalletReputation(history)
  const withoutTarget = scoreWalletReputation(history.filter((item) => item.contract !== 'target'))
  assert.equal(withTarget.closedPositions, 3)
  assert.equal(withoutTarget.closedPositions, 2)
})

test('requires repeat history before granting reputation', () => {
  const thin = scoreWalletReputation([closedWin], 2)
  assert.equal(thin.reputationScore, 0)
  assert.ok(thin.riskFlags.includes('insufficient_history'))
})

test('zeros alpha when there are no real buyers', () => {
  const scored = scoreToken({
    ...healthyToken,
    demand: { ...healthyDemand, realBuyers: 0, independentBuyers: 0, netInflowUsd: 0 },
  })
  assert.equal(scored.alphaScore, 0)
  assert.equal(scored.scored, false)
  assert.ok(scored.riskFlags.includes('insufficient_real_buyers'))
})

/**
 * Regression test for the bundles that reached the top of the table on manual review: a handful
 * of buyers against a multi-million market cap. A thin buyer base must be excluded outright, not
 * merely scored lower, however healthy the token looks on every other axis.
 */
test('excludes bundle-shaped tokens with a thin buyer base', () => {
  const bundle = scoreToken({
    ...healthyToken,
    demand: { ...healthyDemand, realBuyers: 17, independentBuyers: 1 },
  })
  assert.equal(bundle.alphaScore, 0)
  assert.equal(bundle.scored, false)
  assert.ok(bundle.riskFlags.includes('insufficient_real_buyers'))

  // Just under the floor is still excluded; the gate is hard, not a gradient.
  const justUnder = scoreToken({ ...healthyToken, demand: { ...healthyDemand, realBuyers: 99 } })
  assert.equal(justUnder.alphaScore, 0)
})

/**
 * Regression test for TNOS, which scored 77.4 and was confirmed a scam by manual review.
 *
 * It passed every check that existed at the time: 91% buyer independence, 10/10 wealthy top
 * holders, $129k median holder wealth, all safety gates clean. What gave it away by eye was the
 * arithmetic — 70 buyers cannot hold up a $5.2M valuation. That is $74,600 of market cap per
 * buyer, against an observed p50 of ~$3.5k and p75 of ~$14.7k.
 */
test('excludes a large valuation resting on very few buyers', () => {
  const tnos = scoreToken({
    ...healthyToken,
    marketCap: 5_197_696,
    maxMcapPerBuyer: 25_000,
    demand: {
      ...healthyDemand,
      realBuyers: 70,
      independentBuyers: 64,
      enrichedHolders: 10,
      wealthyHolders: 10,
    },
  })
  assert.equal(tnos.alphaScore, 0, 'a $5.2M cap behind 70 buyers must not score')
  assert.equal(tnos.scored, false)
  assert.ok(tnos.riskFlags.includes('mcap_per_buyer_too_high'))

  // The same buyer base supporting a proportionate valuation is fine. minRealBuyers is set
  // explicitly to the production floor so this asserts the ratio gate, not the count gate.
  const proportionate = scoreToken({
    ...healthyToken,
    marketCap: 200_000,
    maxMcapPerBuyer: 25_000,
    minRealBuyers: 50,
    demand: { ...healthyDemand, realBuyers: 70, independentBuyers: 64 },
  })
  assert.ok(proportionate.alphaScore > 0)
})

test('does not score tokens whose trade history is incomplete', () => {
  // A partial backfill yields a lower-bound buyer count, so the caller must not mark it verified.
  for (const evidenceTier of ['partial', 'unverified'] as const) {
    const scored = scoreToken({ ...healthyToken, evidenceTier })
    assert.equal(scored.alphaScore, 0)
    assert.equal(scored.scored, false)
  }
})

test('rewards a broader buyer base', () => {
  const wide = scoreToken({ ...healthyToken, demand: { ...healthyDemand, realBuyers: 700 } })
  const narrow = scoreToken({ ...healthyToken, demand: { ...healthyDemand, realBuyers: 110 } })
  assert.ok(wide.alphaScore > narrow.alphaScore)
})

test('rewards wealthy top holders and flags throwaway ones', () => {
  const wealthy = scoreToken({
    ...healthyToken,
    demand: { ...healthyDemand, enrichedHolders: 10, wealthyHolders: 9 },
  })
  const poor = scoreToken({
    ...healthyToken,
    demand: { ...healthyDemand, enrichedHolders: 10, wealthyHolders: 0 },
  })
  assert.ok(wealthy.alphaScore > poor.alphaScore)
  assert.ok(poor.riskFlags.includes('no_wealthy_holders'))
  // Not flagged when no holders were sampled — absence of data is not evidence of a bundle.
  const unsampled = scoreToken({
    ...healthyToken,
    demand: { ...healthyDemand, enrichedHolders: 0, wealthyHolders: 0 },
  })
  assert.equal(unsampled.riskFlags.includes('no_wealthy_holders'), false)
})

test('can require wealthy holders as a hard gate when configured', () => {
  const scored = scoreToken({
    ...healthyToken,
    minWealthyHolders: 3,
    demand: { ...healthyDemand, enrichedHolders: 10, wealthyHolders: 1 },
  })
  assert.equal(scored.alphaScore, 0)
  assert.equal(scored.scored, false)
})

test('zeros alpha when demand is net outflow', () => {
  const scored = scoreToken({
    ...healthyToken,
    demand: { ...healthyDemand, netInflowUsd: -1_000 },
  })
  assert.equal(scored.alphaScore, 0)
  assert.ok(scored.riskFlags.includes('net_outflow'))
})

test('zeros alpha when a safety gate failed', () => {
  const scored = scoreToken({ ...healthyToken, safetyFailed: true })
  assert.equal(scored.alphaScore, 0)
  assert.equal(scored.scored, false)
})

test('does not score tokens without trade evidence', () => {
  for (const evidenceTier of ['partial', 'unverified'] as const) {
    const scored = scoreToken({ ...healthyToken, evidenceTier })
    assert.equal(scored.alphaScore, 0)
    assert.equal(scored.scored, false)
  }
})

test('flags buyers that only ever traded this one token', () => {
  const scored = scoreToken({
    ...healthyToken,
    demand: { ...healthyDemand, independentBuyers: 0 },
  })
  assert.ok(scored.riskFlags.includes('only_single_purpose_wallets'))
})

/**
 * Wallet-farm detection, using the real shapes observed on chain.
 *
 * USOC showed 243 buyers of which zero had ever traded another token, while organically traded
 * tokens of the same age sat at 95-100% independence. Independence is a ratio, so unlike an
 * absolute buyer count it does not degrade when we sample a token's trades more shallowly.
 */
test('excludes wallet farms by buyer independence', () => {
  const farm = scoreToken({
    ...healthyToken,
    minIndependentShare: 0.5,
    demand: { ...healthyDemand, realBuyers: 243, independentBuyers: 0 },
  })
  assert.equal(farm.alphaScore, 0)
  assert.equal(farm.scored, false)
  assert.ok(farm.riskFlags.includes('only_single_purpose_wallets'))

  // Partial independence below the bar is still excluded, and flagged distinctly.
  const thin = scoreToken({
    ...healthyToken,
    minIndependentShare: 0.5,
    demand: { ...healthyDemand, realBuyers: 200, independentBuyers: 20 },
  })
  assert.equal(thin.alphaScore, 0)
  assert.ok(thin.riskFlags.includes('low_buyer_independence'))

  // An organically traded token clears it despite having far fewer buyers than the farm.
  const organic = scoreToken({
    ...healthyToken,
    minIndependentShare: 0.5,
    demand: { ...healthyDemand, realBuyers: 120, independentBuyers: 114 },
  })
  assert.ok(organic.alphaScore > 0)
  assert.equal(organic.scored, true)
})

test('penalizes concentration, snipers and wash trading continuously', () => {
  const clean = scoreToken(healthyToken)
  const concentrated = scoreToken({
    ...healthyToken,
    demand: { ...healthyDemand, topBuyerShare: 0.95 },
  })
  const sniped = scoreToken({ ...healthyToken, demand: { ...healthyDemand, sniperShare: 0.45 } })
  const washed = scoreToken({ ...healthyToken, demand: { ...healthyDemand, washRatio: 0.3 } })

  assert.ok(clean.alphaScore > concentrated.alphaScore)
  assert.ok(clean.alphaScore > sniped.alphaScore)
  assert.ok(clean.alphaScore > washed.alphaScore)
  // Penalties degrade the score rather than collapsing it to zero, unlike the v1 AND-gate.
  assert.ok(concentrated.alphaScore > 0)
})

test('rewards independent buyer breadth over raw buyer count', () => {
  const broad = scoreToken({ ...healthyToken, demand: { ...healthyDemand, independentBuyers: 15 } })
  const narrow = scoreToken({ ...healthyToken, demand: { ...healthyDemand, independentBuyers: 2 } })
  assert.ok(broad.alphaScore > narrow.alphaScore)
})

test('accepts a safe market', () => {
  const safety = evaluateTokenSafety(safeMarket)
  assert.equal(safety.safe, true)
  assert.deepEqual(safety.riskFlags, [])
})

test('flags rug-prone liquidity relative to market cap', () => {
  const safety = evaluateTokenSafety({ ...safeMarket, liquidity: 2_000, marketCap: 5_000_000 })
  assert.equal(safety.safe, false)
  assert.ok(safety.riskFlags.includes('low_liquidity_ratio'))
})

test('flags wash volume only when the buyer set is small', () => {
  const churnFewBuyers = evaluateTokenSafety({
    ...safeMarket,
    volume24h: 10_000_000,
    liquidity: 100_000,
    distinctBuyers: 5,
  })
  assert.ok(churnFewBuyers.riskFlags.includes('wash_volume'))

  // A busy token with many participants can legitimately turn over its liquidity repeatedly.
  const churnManyBuyers = evaluateTokenSafety({
    ...safeMarket,
    volume24h: 10_000_000,
    liquidity: 100_000,
    distinctBuyers: 500,
  })
  assert.equal(churnManyBuyers.riskFlags.includes('wash_volume'), false)
})

test('flags sniper-dominated launches and buyer concentration', () => {
  assert.ok(evaluateTokenSafety({ ...safeMarket, sniperShare: 0.8 }).riskFlags.includes('sniper_dominated'))
  assert.ok(
    evaluateTokenSafety({ ...safeMarket, topBuyerShare: 0.85 }).riskFlags.includes('buyer_concentration')
  )
})

test('flags honeypot shape when buyers cannot sell', () => {
  const safety = evaluateTokenSafety({ ...safeMarket, distinctBuyers: 200, distinctSellers: 2 })
  assert.ok(safety.riskFlags.includes('honeypot_risk'))
})

test('flags fdv overhang and thin single pairs', () => {
  assert.ok(
    evaluateTokenSafety({ ...safeMarket, fdv: 10_000_000, marketCap: 500_000 }).riskFlags.includes(
      'fdv_overhang'
    )
  )
  assert.ok(
    evaluateTokenSafety({ ...safeMarket, pairCount: 1, liquidity: 5_000 }).riskFlags.includes(
      'single_thin_pair'
    )
  )
})

test('skips trade-derived gates when there is no trade evidence', () => {
  // A "partial" token must not be failed for evidence it was never expected to have.
  const safety = evaluateTokenSafety({
    liquidity: 100_000,
    marketCap: 500_000,
    fdv: 550_000,
    volume24h: 250_000,
    pairCount: 3,
    marketHealthy: true,
    marketHealthFresh: true,
  })
  assert.equal(safety.safe, true)
})

test('classifies fresh wallets from funding age and tags', () => {
  const now = 1_700_000_000
  assert.equal(
    isFreshWallet({
      tags: ['fresh'],
      fundingUnixTime: 0,
      firstObservedAt: now - 30 * 86_400,
      distinctTokenCount: 5,
      now,
      freshWalletDays: 7,
    }),
    true
  )
  assert.equal(
    isFreshWallet({
      tags: [],
      fundingUnixTime: now - 2 * 86_400,
      firstObservedAt: now - 2 * 86_400,
      distinctTokenCount: 1,
      now,
      freshWalletDays: 7,
    }),
    true
  )
  assert.equal(
    isFreshWallet({
      tags: ['smart_trader'],
      fundingUnixTime: now - 60 * 86_400,
      firstObservedAt: now - 60 * 86_400,
      distinctTokenCount: 4,
      now,
      freshWalletDays: 7,
    }),
    false
  )
})

test('real buyers exclude snipers, burners, wash traders and tagged wallets', () => {
  const base = {
    tags: [],
    netFlowUsd: 1_000,
    isFresh: false,
    isSniper: false,
    distinctOtherTokens: 4,
    washRatio: 0,
  }
  assert.equal(isRealBuyer(base), true)
  assert.equal(isRealBuyer({ ...base, tags: ['bundler'] }), false)
  assert.equal(isRealBuyer({ ...base, isFresh: true }), false)
  assert.equal(isRealBuyer({ ...base, isSniper: true }), false)
  assert.equal(isRealBuyer({ ...base, washRatio: 0.9 }), false)
  // Small retail buys count by default: on new launches most genuine buyers net under $10, and
  // a dollar floor here wiped out the buyer-count signal entirely.
  assert.equal(isRealBuyer({ ...base, netFlowUsd: 5 }), true)
  // Net sellers and flat wallets never count, whatever the floor.
  assert.equal(isRealBuyer({ ...base, netFlowUsd: 0 }), false)
  assert.equal(isRealBuyer({ ...base, netFlowUsd: -100 }), false)
  // An explicit floor is still honoured when configured.
  assert.equal(isRealBuyer({ ...base, netFlowUsd: 5, minPositionUsd: 50 }), false)
  // A real buyer that has only ever touched this token is not independent.
  assert.equal(isIndependentBuyer({ ...base, distinctOtherTokens: 0 }), false)
})
