import assert from 'node:assert/strict'
import test from 'node:test'
import { selectTokenMarketHealth, type DexPair } from './dexscreener'

test('selects the highest-liquidity Solana base-token pair', () => {
  const contract = 'EsL3AQw11KoBtEpbUZXkgWh4xwiyod6A5U3KYmwEPUMP'
  const pairs: DexPair[] = [
    {
      chainId: 'solana',
      pairAddress: 'pair-low',
      url: 'https://dexscreener.com/solana/pair-low',
      baseToken: { address: contract },
      priceUsd: '0.01',
      marketCap: 1_000_000,
      fdv: 1_000_000,
      liquidity: { usd: 5_000 },
      volume: { h24: 10_000 },
      priceChange: { h24: 12 },
    },
    {
      chainId: 'solana',
      pairAddress: 'pair-high',
      url: 'https://dexscreener.com/solana/pair-high',
      baseToken: { address: contract },
      priceUsd: '0.02',
      marketCap: 18_600_000,
      fdv: 18_600_000,
      liquidity: { usd: 300_000 },
      volume: { h24: 200_000 },
      priceChange: { h24: 40 },
    },
    {
      chainId: 'ethereum',
      pairAddress: 'pair-eth',
      baseToken: { address: contract },
      liquidity: { usd: 999_999 },
    },
  ]

  const health = selectTokenMarketHealth(contract, pairs)
  assert.ok(health)
  assert.equal(health.pairAddress, 'pair-high')
  assert.equal(health.pairCount, 2)
  assert.equal(health.liquidity, 305_000)
  assert.equal(health.volume24h, 210_000)
  assert.equal(health.price, 0.02)
})

test('returns null when no matching Solana base-token pair exists', () => {
  const health = selectTokenMarketHealth('Mint111111111111111111111111111111111111111', [
    {
      chainId: 'solana',
      baseToken: { address: 'OtherMint1111111111111111111111111111111111' },
      liquidity: { usd: 50_000 },
    },
  ])
  assert.equal(health, null)
})
