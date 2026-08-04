import { config } from '../config'
import { cacheGet, cacheSet } from './redis'

export async function getRobinhoodWalletBalance(address: string): Promise<number | null> {
  if (!config.alchemy.apiKey || !config.alchemy.robinhoodUrl) return null

  const cacheKey = `alchemy:balance:rh:${address}`
  const cached = await cacheGet<number>(cacheKey)
  if (cached !== null) return cached

  const res = await fetch(config.alchemy.robinhoodUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getBalance',
      params: [address, 'latest'],
    }),
  })

  if (!res.ok) return null

  const json = (await res.json()) as { result?: string }
  if (!json.result) return null

  const balance = parseInt(json.result, 16) / 1e18
  await cacheSet(cacheKey, balance, 60)
  return balance
}

export async function getRobinhoodTransactions(address: string) {
  if (!config.alchemy.apiKey || !config.alchemy.robinhoodUrl) return null

  const cacheKey = `alchemy:txs:rh:${address}`
  const cached = await cacheGet<unknown>(cacheKey)
  if (cached) return cached

  const res = await fetch(config.alchemy.robinhoodUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'alchemy_getAssetTransfers',
      params: [{ fromAddress: address, category: ['external', 'erc20'], maxCount: '0x64' }],
    }),
  })

  if (!res.ok) return null
  const data = await res.json()
  await cacheSet(cacheKey, data, 120)
  return data
}

export async function getWalletBalance(address: string, chain: string): Promise<number | null> {
  if (chain === 'solana') {
    const { getSolanaWalletBalance } = await import('./helius')
    return getSolanaWalletBalance(address)
  }
  if (chain === 'robinhood') {
    return getRobinhoodWalletBalance(address)
  }
  return null
}
