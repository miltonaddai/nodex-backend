import { config } from '../config'
import { throttleHelius } from './rate-limit'

export interface WalletAnalytics {
  address: string
  balance: number
  totalProfit: number
  winRate: number
  trades: number
  volume: number
  lastActive: string
}

export interface HeliusTokenTransfer {
  fromUserAccount?: string
  toUserAccount?: string
  mint?: string
  tokenAmount?: number
}

export interface HeliusNativeTransfer {
  fromUserAccount?: string
  toUserAccount?: string
  amount?: number
}

export interface HeliusEnhancedTransaction {
  signature?: string
  slot?: number
  timestamp?: number
  type?: string
  feePayer?: string
  tokenTransfers?: HeliusTokenTransfer[]
  nativeTransfers?: HeliusNativeTransfer[]
}

export interface NormalizedSwap {
  contract: string
  walletAddress: string
  signature: string
  eventIndex: number
  side: 'buy' | 'sell'
  tokenAmount: number
  quoteAmount: number
  quoteSymbol: 'SOL' | 'USDC' | 'USDT'
  quoteUsd: number
  blockTime: number
  minutesAfterLaunch: number
  suspicious: boolean
}

export function normalizedSwapIdentity(swap: Pick<NormalizedSwap, 'signature' | 'eventIndex'>): string {
  return `${swap.signature}:${swap.eventIndex}`
}

const STABLECOINS = new Map([
  ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'USDC' as const],
  ['Es9vMFrzaCERmJfrF4H2FYD5kj5YKEj8K1GmJ6eDqGf', 'USDT' as const],
])

export async function getAddressTransactionsPage(
  address: string,
  before?: string,
  limit = 100
): Promise<HeliusEnhancedTransaction[]> {
  if (!config.helius.apiKey) return []
  for (let attempt = 0; attempt < 3; attempt++) {
    await throttleHelius()
    const params = new URLSearchParams({
      'api-key': config.helius.apiKey,
      limit: String(Math.min(Math.max(limit, 1), 100)),
      type: 'SWAP',
    })
    if (before) params.set('before', before)
    const res = await fetch(`${config.helius.baseUrl}/addresses/${address}/transactions?${params}`, {
      signal: AbortSignal.timeout(config.worker.providerRequestTimeoutMs),
    })
    if (res.ok) return (await res.json()) as HeliusEnhancedTransaction[]
    if (res.status !== 429 || attempt === 2) {
      throw new Error(`Helius API error: ${res.status} ${res.statusText}`)
    }
    const retryAfterSeconds = Number(res.headers.get('retry-after') ?? 0)
    const waitMs = Math.max(retryAfterSeconds * 1000, 2_000 * 2 ** attempt)
    console.warn(`[helius] Rate limited; retrying in ${waitMs}ms`)
    await new Promise((resolve) => setTimeout(resolve, waitMs))
  }
  return []
}

function stablecoinFlow(
  transfers: HeliusTokenTransfer[],
  wallet: string,
  outgoing: boolean
): { amount: number; symbol: 'USDC' | 'USDT' } | null {
  for (const transfer of transfers) {
    const symbol = STABLECOINS.get(transfer.mint ?? '')
    if (!symbol) continue
    const matches = outgoing ? transfer.fromUserAccount === wallet : transfer.toUserAccount === wallet
    const amount = Number(transfer.tokenAmount ?? 0)
    if (matches && amount > 0) return { amount, symbol }
  }
  return null
}

function nativeFlow(transfers: HeliusNativeTransfer[], wallet: string, outgoing: boolean): number {
  return transfers.reduce((sum, transfer) => {
    const matches = outgoing ? transfer.fromUserAccount === wallet : transfer.toUserAccount === wallet
    return matches ? sum + Number(transfer.amount ?? 0) / 1e9 : sum
  }, 0)
}

/** Normalize swap-like enhanced transactions from the fee payer's perspective. */
export function normalizeTokenSwaps(
  tx: HeliusEnhancedTransaction,
  contract: string,
  launchedAt: number,
  solUsdPrice: number
): NormalizedSwap[] {
  const wallet = tx.feePayer ?? ''
  const signature = tx.signature ?? ''
  const blockTime = Number(tx.timestamp ?? 0)
  const tokenTransfers = tx.tokenTransfers ?? []
  if (!wallet || !signature || !blockTime || (tx.type && tx.type !== 'SWAP')) return []

  const targetTransfers = tokenTransfers
    .map((transfer, index) => ({ transfer, index }))
    .filter(({ transfer }) => transfer.mint === contract && Number(transfer.tokenAmount ?? 0) > 0)
  if (targetTransfers.length === 0) return []

  // A wallet appearing as both sender and receiver of the target mint in one transaction is a
  // genuine self-trade. Note what is NOT checked here: transfer count. v1 flagged any swap with
  // more than two target-token transfers, which is the normal shape of a multi-hop Jupiter route
  // — that flagged 69% of all trades and penalized exactly the sophisticated traders we want.
  const selfTrade = tokenTransfers.some(
    (transfer) =>
      transfer.mint === contract &&
      transfer.fromUserAccount === wallet &&
      transfer.toUserAccount === wallet
  )
  const impossibleTiming = blockTime < launchedAt

  const swaps: NormalizedSwap[] = []
  for (const { transfer, index } of targetTransfers) {
    const isBuy = transfer.toUserAccount === wallet
    const isSell = transfer.fromUserAccount === wallet
    if (!isBuy && !isSell) continue

    const stable = stablecoinFlow(tokenTransfers, wallet, isBuy)
    const solAmount = nativeFlow(tx.nativeTransfers ?? [], wallet, isBuy)
    const quoteAmount = stable?.amount ?? solAmount
    const quoteSymbol = stable?.symbol ?? 'SOL'
    const quoteUsd = stable ? quoteAmount : quoteAmount * solUsdPrice
    if (!(quoteUsd > 0)) continue

    swaps.push({
      contract,
      walletAddress: wallet,
      signature,
      eventIndex: index,
      side: isBuy ? 'buy' : 'sell',
      tokenAmount: Number(transfer.tokenAmount),
      quoteAmount,
      quoteSymbol,
      quoteUsd,
      blockTime,
      minutesAfterLaunch: Math.max(0, Math.floor((blockTime - launchedAt) / 60)),
      suspicious: selfTrade || impossibleTiming,
    })
  }
  return swaps
}

export async function getWalletTransactions(address: string, chain: string) {
  if (!config.helius.apiKey && chain === 'solana') {
    return null
  }

  if (chain === 'solana' && config.helius.apiKey) {
    return getAddressTransactionsPage(address, undefined, 5)
  }

  return null
}

export async function getSolanaWalletTokenCount(address: string): Promise<number | null> {
  if (!config.helius.apiKey) return null

  let count = 0
  let page = 1
  let hasMore = true

  while (hasMore) {
    await throttleHelius()
    const res = await fetch(
      `https://api.helius.xyz/v1/wallet/${address}/balances?api-key=${config.helius.apiKey}&page=${page}&limit=100`,
      { signal: AbortSignal.timeout(config.worker.providerRequestTimeoutMs) }
    )
    if (!res.ok) return page === 1 ? null : count

    const data = (await res.json()) as {
      balances?: Array<{ balance?: number; usdValue?: number | null }>
      pagination?: { hasMore?: boolean }
    }

    for (const token of data.balances ?? []) {
      if ((token.balance ?? 0) > 0 || (token.usdValue ?? 0) > 0) count += 1
    }

    hasMore = Boolean(data.pagination?.hasMore)
    page += 1
    if (page > 20) break
  }

  return count
}

export async function getSolanaWalletPortfolioUsd(address: string): Promise<number | null> {
  if (!config.helius.apiKey) return null

  let total = 0
  let page = 1
  let hasMore = true

  while (hasMore) {
    await throttleHelius()
    const res = await fetch(
      `https://api.helius.xyz/v1/wallet/${address}/balances?api-key=${config.helius.apiKey}&page=${page}&limit=100`,
      { signal: AbortSignal.timeout(config.worker.providerRequestTimeoutMs) }
    )
    if (!res.ok) return page === 1 ? null : total

    const data = (await res.json()) as {
      balances?: Array<{ usdValue?: number | null }>
      pagination?: { hasMore?: boolean }
    }

    for (const token of data.balances ?? []) {
      if (typeof token.usdValue === 'number' && Number.isFinite(token.usdValue)) {
        total += token.usdValue
      }
    }

    hasMore = Boolean(data.pagination?.hasMore)
    page += 1
    if (page > 20) break
  }

  return total
}

export async function getSolanaWalletBalance(address: string): Promise<number | null> {
  if (!config.helius.apiKey) return null

  await throttleHelius()
  const res = await fetch(`${config.helius.baseUrl}/addresses/${address}/balances?api-key=${config.helius.apiKey}`, {
    signal: AbortSignal.timeout(config.worker.providerRequestTimeoutMs),
  })
  if (!res.ok) return null

  const data = (await res.json()) as { nativeBalance?: number }
  return (data.nativeBalance ?? 0) / 1e9
}

export async function getWalletLastActiveIso(address: string, chain: string): Promise<string | null> {
  if (chain !== 'solana' || !config.helius.apiKey) return null

  try {
    const txs = (await getWalletTransactions(address, chain)) as Array<{ timestamp?: number }> | null
    const ts = txs?.[0]?.timestamp
    if (!ts) return null
    return new Date(ts * 1000).toISOString()
  } catch {
    return null
  }
}

export async function enrichSolanaWalletBalanceUsd(address: string, solUsdPrice: number): Promise<number> {
  const portfolioUsd = await getSolanaWalletPortfolioUsd(address)
  if (portfolioUsd !== null) return Math.round(portfolioUsd)

  const solBalance = await getSolanaWalletBalance(address)
  if (solBalance === null) return 0
  return Math.round(solBalance * solUsdPrice)
}

// --- Launch-insider analysis ---------------------------------------------------------------

async function heliusRpc<T>(method: string, params: unknown): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    await throttleHelius()
    const res = await fetch(`${config.helius.rpcUrl}/?api-key=${config.helius.apiKey}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(config.worker.providerRequestTimeoutMs),
    })
    if (res.status === 429 && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 2_000 * 2 ** attempt))
      continue
    }
    if (!res.ok) throw new Error(`Helius RPC ${method} error: ${res.status}`)
    const json = (await res.json()) as { result?: T; error?: { message?: string } }
    if (json.error) throw new Error(`Helius RPC ${method} error: ${json.error.message ?? 'unknown'}`)
    return json.result as T
  }
  throw new Error(`Helius RPC ${method} rate limited`)
}

export interface SignatureInfo {
  signature: string
  slot: number
  blockTime: number | null
  err: unknown
}

/** An address's transactions oldest first. Only Helius offers ascending order. */
export async function getSignaturesOldestFirst(address: string, limit: number): Promise<SignatureInfo[]> {
  const result = await heliusRpc<{ data?: SignatureInfo[] }>('getTransactionsForAddress', [
    address,
    { transactionDetails: 'signatures', sortOrder: 'asc', limit: Math.min(Math.max(limit, 1), 1000) },
  ])
  return result.data ?? []
}

/** Parses signatures into enhanced transactions, 100 per request. Order is not preserved. */
export async function parseTransactions<T = HeliusEnhancedTransaction>(signatures: string[]): Promise<T[]> {
  const parsed: T[] = []
  for (let index = 0; index < signatures.length; index += 100) {
    for (let attempt = 0; attempt < 4; attempt++) {
      await throttleHelius()
      const res = await fetch(`${config.helius.baseUrl}/transactions?api-key=${config.helius.apiKey}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ transactions: signatures.slice(index, index + 100) }),
        signal: AbortSignal.timeout(config.worker.providerRequestTimeoutMs),
      })
      if (res.status === 429 && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 2_000 * 2 ** attempt))
        continue
      }
      if (!res.ok) throw new Error(`Helius parse error: ${res.status}`)
      parsed.push(...((await res.json()) as T[]))
      break
    }
  }
  return parsed
}

/** The wallet that sent this wallet its first meaningful SOL, or null if none is found early on. */
export async function getFundingSource(wallet: string): Promise<string | null> {
  const signatures = (await getSignaturesOldestFirst(wallet, 15)).filter((s) => !s.err).map((s) => s.signature)
  if (signatures.length === 0) return null
  const txs = (await parseTransactions(signatures)).sort((a, b) => Number(a.timestamp ?? 0) - Number(b.timestamp ?? 0))
  for (const tx of txs) {
    const inflow = (tx.nativeTransfers ?? []).find(
      (transfer) =>
        transfer.toUserAccount === wallet &&
        transfer.fromUserAccount !== wallet &&
        Number(transfer.amount ?? 0) >= 1e7
    )
    if (inflow?.fromUserAccount) return inflow.fromUserAccount
  }
  return null
}

/**
 * Exchange hot wallets and wallet services fund thousands of unrelated users, so sharing one
 * says nothing. They show up as very high transaction rates or very large balances.
 */
export async function isHighThroughputWallet(address: string): Promise<boolean> {
  const signatures = await heliusRpc<Array<{ blockTime?: number | null }>>('getSignaturesForAddress', [address, { limit: 100 }])
  if (signatures.length >= 100) {
    const newest = signatures[0]?.blockTime ?? 0
    const oldest = signatures[signatures.length - 1]?.blockTime ?? 0
    const hours = Math.max((newest - oldest) / 3600, 1 / 60)
    if (signatures.length / hours > 60) return true
  }
  const balance = await heliusRpc<{ value?: number }>('getBalance', [address])
  return Number(balance.value ?? 0) / 1e9 > 20_000
}

export async function getTokenSupply(mint: string): Promise<{ supply: number; decimals: number }> {
  const result = await heliusRpc<{ value?: { uiAmount?: number; decimals?: number } }>('getTokenSupply', [mint])
  return { supply: Number(result.value?.uiAmount ?? 0), decimals: Number(result.value?.decimals ?? 0) }
}

/** Current balance of every holder, from Helius DAS. Capped at `maxPages` × 1000 accounts. */
export async function getTokenHolderBalances(mint: string, decimals: number, maxPages = 25): Promise<Map<string, number>> {
  const balances = new Map<string, number>()
  for (let page = 1; page <= maxPages; page++) {
    const result = await heliusRpc<{ token_accounts?: Array<{ owner?: string; amount?: number }> }>('getTokenAccounts', {
      mint,
      page,
      limit: 1000,
    })
    const accounts = result.token_accounts ?? []
    for (const account of accounts) {
      if (!account.owner) continue
      const amount = Number(account.amount ?? 0) / 10 ** decimals
      balances.set(account.owner, (balances.get(account.owner) ?? 0) + amount)
    }
    if (accounts.length < 1000) break
  }
  return balances
}

/** Unix time of an address's most recent transaction, or null if it has none. */
export async function getLastActivityTime(address: string): Promise<number | null> {
  const signatures = await heliusRpc<Array<{ blockTime?: number | null }>>('getSignaturesForAddress', [
    address,
    { limit: 1 },
  ])
  return signatures[0]?.blockTime ?? null
}
