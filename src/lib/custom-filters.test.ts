import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { matchesRules, parseRules, type FilterableBuy } from './custom-filters'

const now = Date.parse('2026-11-05T12:00:00Z')
const token: FilterableBuy = {
  walletCount: 6,
  netBuyUsd: 40_000,
  buyUsd: 50_000,
  sellUsd: 10_000,
  buyCount: 20,
  marketCap: 800_000,
  liquidity: 90_000,
  volume24h: 2_400_000,
  priceChange24h: 35,
  buyerRealizedPnl30d: 1_200_000,
  lastBuyAt: '2026-11-05T09:00:00Z',
  firstSeenAt: '2026-11-04T12:00:00Z',
  peakMultiple: 2.5,
}

describe('parseRules', () => {
  it('keeps well-formed rules on known fields', () => {
    const rules = parseRules(JSON.stringify([{ field: 'marketCap', op: 'lte', value: 1_000_000 }]))
    assert.deepEqual(rules, [{ field: 'marketCap', op: 'lte', value: 1_000_000 }])
  })

  it('drops unknown fields, bad operators, non-numbers and junk', () => {
    const raw = JSON.stringify([
      { field: 'nope', op: 'gte', value: 1 },
      { field: 'marketCap', op: 'eq', value: 1 },
      { field: 'marketCap', op: 'gte', value: '1' },
      null,
    ])
    assert.deepEqual(parseRules(raw), [])
    assert.deepEqual(parseRules('not json'), [])
    assert.deepEqual(parseRules(undefined), [])
  })
})

describe('matchesRules', () => {
  it('needs every rule to hold', () => {
    const rules = parseRules(
      JSON.stringify([
        { field: 'walletCount', op: 'gte', value: 5 },
        { field: 'marketCap', op: 'lte', value: 1_000_000 },
      ])
    )
    assert.equal(matchesRules(token, rules, now), true)
    assert.equal(matchesRules({ ...token, walletCount: 4 }, rules, now), false)
  })

  it('computes derived fields: sold share, volume to market cap, hours since', () => {
    const check = (field: string, op: 'gte' | 'lte', value: number) => matchesRules(token, [{ field, op, value }], now)
    assert.equal(check('soldPct', 'lte', 20), true) // 10K of 50K sold
    assert.equal(check('volumeToMcap', 'gte', 3), true) // 2.4M / 800K
    assert.equal(check('lastBuyHours', 'lte', 3), true)
    assert.equal(check('firstSeenHours', 'gte', 24), true)
  })

  it('fails a rule when the token has no value for the field', () => {
    assert.equal(matchesRules({ ...token, peakMultiple: null }, [{ field: 'peakMultiple', op: 'gte', value: 1 }], now), false)
  })
})
