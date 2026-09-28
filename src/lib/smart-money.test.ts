import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  aggregateBuying,
  isLiveTradingWallet,
  isProfitableTrader,
  selectSmartWallets,
  summarizeWalletFlows,
  SYSTEM_PROGRAM,
  type Swap,
} from './smart-money'

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

test('leaderboard junk is rejected', () => {
  // One-trade wallet holding millions of paper profit on a $10k buy.
  assert.equal(isProfitableTrader({ address: 'A', pnl: 96_000_000, realizedPnl: 0, volume: 10_000, trades: 1 }, 10), false)
  // $42M realized cancelled by $42M unrealized: total PnL is negative.
  assert.equal(isProfitableTrader({ address: 'B', pnl: -156, realizedPnl: 42_000_000, volume: 85_000_000, trades: 15 }, 10), false)
  // Mostly unrealized profit.
  assert.equal(isProfitableTrader({ address: 'C', pnl: 45_000_000, realizedPnl: 257_000, volume: 375_000, trades: 25 }, 10), false)
})

test('a trader whose profit is taken qualifies', () => {
  assert.equal(isProfitableTrader({ address: 'D', pnl: 1_182_769, realizedPnl: 1_194_118, volume: 8_297_003, trades: 1816 }, 10), true)
})

test('smart wallets are ranked by realized profit and deduplicated', () => {
  const picked = selectSmartWallets(
    [
      { address: 'X', pnl: 500, realizedPnl: 500, volume: 1, trades: 20 },
      { address: 'Y', pnl: 900, realizedPnl: 900, volume: 1, trades: 20 },
      { address: 'X', pnl: 500, realizedPnl: 500, volume: 1, trades: 20 },
    ],
    10,
    5
  )
  assert.deepEqual(picked.map((t) => t.address), ['Y', 'X'])
})

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

test('closed, program-owned, drained and idle addresses are not live trading wallets', () => {
  const now = 1_000_000
  const opts = { minSol: 0.1, maxIdleDays: 7, now }
  const token = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
  assert.equal(isLiveTradingWallet(undefined, now, opts), false, 'closed account')
  assert.equal(isLiveTradingWallet({ owner: token, lamports: 2e9 }, now, opts), false, 'token account')
  assert.equal(isLiveTradingWallet({ owner: SYSTEM_PROGRAM, lamports: 2e6 }, now, opts), false, 'dust balance')
  assert.equal(isLiveTradingWallet({ owner: SYSTEM_PROGRAM, lamports: 2e9 }, now - 30 * 86_400, opts), false, 'idle')
  assert.equal(isLiveTradingWallet({ owner: SYSTEM_PROGRAM, lamports: 2e9 }, now - 3600, opts), true)
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
