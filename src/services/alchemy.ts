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

/**
 * ETH balances for up to 20 Robinhood Chain addresses in one batched request. Blockscout serves
 * the same number but takes several seconds per address.
 */
export async function getRobinhoodEthBalances(addresses: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>()
  if (!config.alchemy.robinhoodUrl || addresses.length === 0) return result
  const batch = addresses.slice(0, 20)
  const res = await fetch(config.alchemy.robinhoodUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(batch.map((address, id) => ({ jsonrpc: '2.0', id, method: 'eth_getBalance', params: [address, 'latest'] }))),
    signal: AbortSignal.timeout(config.worker.providerRequestTimeoutMs),
  })
  if (!res.ok) return result
  const body = (await res.json()) as Array<{ id: number; result?: string }>
  for (const entry of body) {
    if (entry.result) result.set(batch[entry.id], Number(BigInt(entry.result)) / 1e18)
  }
  return result
}
