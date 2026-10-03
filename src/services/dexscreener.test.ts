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

test('ignores a deeper spoofed pool when a trusted-quote pool exists', () => {
  const contract = 'BopMint11111111111111111111111111111111111'
  const health = selectTokenMarketHealth(contract, [
    {
      chainId: 'solana',
      pairAddress: 'spoof',
      baseToken: { address: contract },
      quoteToken: { address: 'FakeQuote111111111111111111111111111111111', symbol: 'SOL' },
      priceUsd: '7.24',
      marketCap: 7_242_299_720,
      liquidity: { usd: 1_192_171_715 },
      volume: { h24: 50 },
    },
    {
      chainId: 'solana',
      pairAddress: 'real',
      baseToken: { address: contract },
      quoteToken: { address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'Bonk' },
      priceUsd: '0.000438',
      marketCap: 438_403,
      liquidity: { usd: 71_607 },
      volume: { h24: 18_995_181 },
    },
  ])
  assert.ok(health)
  assert.equal(health.pairAddress, 'real')
  assert.equal(health.marketCap, 438_403)
  // The spoofed pool's liquidity and volume are left out of the totals too.
  assert.equal(health.liquidity, 71_607)
  assert.equal(health.volume24h, 18_995_181)
  assert.equal(health.pairCount, 2)
})

test('trusts Robinhood Chain pools quoted in WETH', () => {
  const contract = '0xabc0000000000000000000000000000000000001'
  const health = selectTokenMarketHealth(
    contract,
    [
      {
        chainId: 'robinhood',
        pairAddress: 'fake',
        baseToken: { address: contract },
        quoteToken: { address: '0x9999999999999999999999999999999999999999' },
        marketCap: 90_000_000,
        liquidity: { usd: 80_000_000 },
      },
      {
        chainId: 'robinhood',
        pairAddress: 'weth',
        baseToken: { address: contract },
        quoteToken: { address: '0x0bd7d308f8e1639fab988df18a8011f41eacad73' },
        marketCap: 1_200_000,
        liquidity: { usd: 150_000 },
      },
    ],
    'robinhood'
  )
  assert.equal(health?.pairAddress, 'weth')
})
