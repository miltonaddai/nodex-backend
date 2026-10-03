import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isEarlySignal } from './early-signal'

// Agency at its first snapshot, 2 Oct 02:08 UTC.
const agency = { marketCap: 46_000, liquidity: 19_000, volume24h: 1_771_000, walletCount: 4, buyUsd: 13_200, sellUsd: 2_500 }

test('Agency at first sighting is an early signal', () => {
  assert.equal(isEarlySignal(agency), true)
})

test('a single trader is not enough', () => {
  assert.equal(isEarlySignal({ ...agency, walletCount: 1 }), false)
})

test('market cap above $100K does not qualify', () => {
  assert.equal(isEarlySignal({ ...agency, marketCap: 150_000, volume24h: 5_000_000 }), false)
})

test('thin trading for its size does not qualify', () => {
  assert.equal(isEarlySignal({ ...agency, volume24h: 300_000 }), false)
})

test('traders already selling does not qualify', () => {
  assert.equal(isEarlySignal({ ...agency, sellUsd: 6_000 }), false)
})

test('a misreported market cap (liquidity far above it) does not qualify', () => {
  assert.equal(isEarlySignal({ ...agency, marketCap: 32_000, liquidity: 3_100_000, volume24h: 1_000_000 }), false)
})
