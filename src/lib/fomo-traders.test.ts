import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fomoListAgeDays, fomoTraderList, isFomoListStale, walletForChain, type FomoTrader } from './fomo-traders'

const trader: FomoTrader = {
  rank: 1,
  userId: 'u1',
  handle: 'trader',
  displayName: 'Trader',
  avatar: '',
  pnl30dUsd: 1000,
  pnl7dUsd: null,
  pnlAllUsd: null,
  volumeUsd: 5000,
  trades: 10,
  followers: 100,
  wallets: { solana: 'SoLwallet', evm: '0xevm' },
}

test('Robinhood Chain uses the EVM wallet and Solana the Solana wallet', () => {
  assert.equal(walletForChain(trader, 'solana'), 'SoLwallet')
  assert.equal(walletForChain(trader, 'robinhood'), '0xevm')
  assert.equal(walletForChain({ ...trader, wallets: { solana: 'SoLwallet', evm: null } }, 'robinhood'), null)
})

test('the saved list is flagged stale after 35 days', () => {
  const saved = Date.parse(fomoTraderList().generatedAt)
  assert.equal(isFomoListStale(saved + 10 * 86_400_000), false)
  assert.equal(isFomoListStale(saved + 36 * 86_400_000), true)
  assert.equal(Math.round(fomoListAgeDays(saved + 2 * 86_400_000)), 2)
})

test('the saved list has traders with wallets', () => {
  const list = fomoTraderList()
  assert.ok(list.traders.length > 0)
  assert.ok(list.traders.every((t) => t.wallets.solana || t.wallets.evm))
})
