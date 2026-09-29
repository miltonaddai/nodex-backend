import assert from 'node:assert/strict'
import { test } from 'node:test'
import { aggregateBuying, summarizeWalletFlows, type Swap } from './smart-money'

const SOL = 'So11111111111111111111111111111111111111112'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

function buy(token: string, usd: number, at: number): Swap {
  return {
    blockTime: at,
    volumeUsd: usd,
    base: { address: token, symbol: token, uiChangeAmount: 1000 },
    quote: { address: SOL, symbol: 'SOL', uiChangeAmount: -usd / 100 },
  }
}

function sell(token: string, usd: number, at: number): Swap {
  return {
    blockTime: at,
    volumeUsd: usd,
    base: { address: token, symbol: token, uiChangeAmount: -1000 },
    quote: { address: SOL, symbol: 'SOL', uiChangeAmount: usd / 100 },
  }
}

test('swaps into SOL or stablecoins are not counted as token buys', () => {
  const flows = summarizeWalletFlows([
    {
      blockTime: 1,
      volumeUsd: 500,
      base: { address: SOL, symbol: 'SOL', uiChangeAmount: 5 },
      quote: { address: USDC, symbol: 'USDC', uiChangeAmount: -500 },
    },
  ])
  assert.equal(flows.size, 0)
})

test('a wallet that sold more than it bought is exiting, not buying', () => {
  // Bought $14k in pieces, then dumped $47.8k: seen on a real top trader.
  const flows = summarizeWalletFlows([buy('GTA', 4000, 1), buy('GTA', 4200, 2), buy('GTA', 5800, 3), sell('GTA', 47_800, 4)])
  const buying = aggregateBuying(new Map([['W1', flows]]), 250)
  assert.equal(buying.length, 0)
})

test('tokens rank by how many top wallets are net buying, then by size', () => {
  const walletFlows = new Map([
    ['W1', summarizeWalletFlows([buy('ALPHA', 1000, 10), buy('BIG', 50_000, 11)])],
    ['W2', summarizeWalletFlows([buy('ALPHA', 800, 12)])],
    ['W3', summarizeWalletFlows([buy('ALPHA', 600, 13), buy('DUST', 50, 14)])],
  ])
  const buying = aggregateBuying(walletFlows, 250)

  assert.deepEqual(buying.map((t) => t.contract), ['ALPHA', 'BIG'])
  assert.equal(buying[0].walletCount, 3)
  assert.equal(buying[0].netBuyUsd, 2400)
  assert.deepEqual(buying[0].wallets.map((w) => w.wallet), ['W1', 'W2', 'W3'])
  assert.equal(buying[0].firstBuyAt, 10)
  assert.equal(buying[0].lastBuyAt, 13)
})

test('ties on wallet count go to the token bought by more profitable wallets', () => {
  const walletFlows = new Map([
    ['Top1', summarizeWalletFlows([buy('ELITE', 500, 1)])],
    ['Top2', summarizeWalletFlows([buy('ELITE', 500, 2)])],
    ['Low1', summarizeWalletFlows([buy('BIGBAG', 90_000, 3)])],
    ['Low2', summarizeWalletFlows([buy('BIGBAG', 90_000, 4)])],
  ])
  const profit = new Map([
    ['Top1', 1_400_000],
    ['Top2', 1_200_000],
    ['Low1', 60_000],
    ['Low2', 55_000],
  ])
  const buying = aggregateBuying(walletFlows, 250, profit)

  assert.deepEqual(buying.map((t) => t.contract), ['ELITE', 'BIGBAG'])
  assert.equal(buying[0].buyerRealizedPnl, 2_600_000)
})

test('Robinhood swaps into ETH, WETH or USDG are not buys, whatever the address casing', () => {
  const weth = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'
  const flows = summarizeWalletFlows(
    [
      {
        blockTime: 1,
        volumeUsd: 900,
        base: { address: weth, symbol: 'WETH', uiChangeAmount: 0.3 },
        quote: { address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', symbol: 'USDG', uiChangeAmount: -900 },
      },
      {
        blockTime: 2,
        volumeUsd: 400,
        base: { address: '0xMEME', symbol: 'MEME', uiChangeAmount: 1000 },
        quote: { address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', uiChangeAmount: -0.1 },
      },
    ],
    'robinhood'
  )
  assert.deepEqual([...flows.keys()], ['0xMEME'])
})
