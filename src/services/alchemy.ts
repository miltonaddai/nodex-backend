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

// --- Robinhood Chain wallet checks for smart money ---------------------------------------------

type RpcCall = { method: string; params: unknown[] }

/**
 * Alchemy's free plan allows 500 compute units per second. A batch of 10 addresses (eth_getCode
 * plus eth_getBalance each) costs about 450, so batches go out once a second.
 */
const ROBINHOOD_RPC_MIN_INTERVAL_MS = 1_000
let lastRobinhoodRpc = 0

/** Sends JSON-RPC calls to the Robinhood Chain endpoint as one batch. Results keep call order. */
async function robinhoodRpcBatch<T>(calls: RpcCall[]): Promise<Array<T | null>> {
  if (!config.alchemy.robinhoodUrl || calls.length === 0) return calls.map(() => null)
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = Math.max(0, ROBINHOOD_RPC_MIN_INTERVAL_MS - (Date.now() - lastRobinhoodRpc))
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    lastRobinhoodRpc = Date.now()
    const res = await fetch(config.alchemy.robinhoodUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(calls.map((call, id) => ({ jsonrpc: '2.0', id, ...call }))),
      signal: AbortSignal.timeout(config.worker.providerRequestTimeoutMs),
    })
    if (res.status === 429 && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** attempt))
      continue
    }
    if (!res.ok) throw new Error(`Alchemy Robinhood RPC error: ${res.status}`)
    const body = (await res.json()) as Array<{ id: number; result?: T }>
    const byId = new Map(body.map((entry) => [entry.id, entry.result ?? null]))
    return calls.map((_, id) => byId.get(id) ?? null)
  }
  throw new Error('Alchemy Robinhood RPC rate limited')
}

export interface EvmAccountSummary {
  /** '0x' for an ordinary wallet, bytecode for a contract. */
  code: string
  balanceWei: bigint
}

/** Code and ETH balance for many Robinhood Chain addresses, 10 per batch request. */
export async function getRobinhoodAccountSummaries(addresses: string[]): Promise<Map<string, EvmAccountSummary>> {
  const result = new Map<string, EvmAccountSummary>()
  for (let index = 0; index < addresses.length; index += 10) {
    const batch = addresses.slice(index, index + 10)
    const results = await robinhoodRpcBatch<string>(
      batch.flatMap((address) => [
        { method: 'eth_getCode', params: [address, 'latest'] },
        { method: 'eth_getBalance', params: [address, 'latest'] },
      ])
    )
    batch.forEach((address, i) => {
      const code = results[i * 2]
      const balance = results[i * 2 + 1]
      if (code !== null && balance !== null) result.set(address, { code, balanceWei: BigInt(balance) })
    })
  }
  return result
}
