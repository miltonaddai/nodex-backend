import { config } from '../config'
import type { LaunchTransaction } from '../lib/insider-detection'
import { throttleHelius } from './rate-limit'
import { cacheGet, cacheSet } from './redis'
import { ApiKeyPool } from './api-key-pool'

/** Falls back to the next Helius key when one runs out of credits. */
const heliusKeys = new ApiKeyPool('helius', config.helius.apiKeys)

// --- Credit meter ------------------------------------------------------------------------------

/**
 * Helius credits spent by this process, by call type. Costs follow Helius's published pricing
 * (helius.dev/docs/billing/credits); they are an estimate, the dashboard is the source of truth.
 */
const credits = new Map<string, number>()

/** Credits per call for plain JSON-RPC methods. Methods not listed cost 1. */
const RPC_CREDITS: Record<string, number> = {
  getTokenAccounts: 10,
  getAsset: 10,
  getAssetsByOwner: 10,
  // Metered by response size, charged in getRawTransactionsForAddress / getSignaturesOldestFirst.
  getTransactionsForAddress: 0,
}

function charge(kind: string, amount: number): void {
  credits.set(kind, (credits.get(kind) ?? 0) + amount)
}

/** Total credits spent so far, and the breakdown by call type. */
export function heliusCreditsUsed(): { total: number; byKind: Record<string, number> } {
  const byKind = Object.fromEntries([...credits.entries()].sort((a, b) => b[1] - a[1]))
  return { total: [...credits.values()].reduce((sum, value) => sum + value, 0), byKind }
}

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
      limit: String(Math.min(Math.max(limit, 1), 100)),
      type: 'SWAP',
    })
    if (before) params.set('before', before)
    const res = await heliusKeys.fetch((key) => ({
      url: `${config.helius.baseUrl}/addresses/${address}/transactions?api-key=${key}&${params}`,
      init: { signal: AbortSignal.timeout(config.worker.providerRequestTimeoutMs) },
    }))
    if (res.ok) {
      charge('enhanced:addressHistory', 100)
      return (await res.json()) as HeliusEnhancedTransaction[]
    }
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

// --- Raw transactions (getTransactionsForAddress, full) -----------------------------------------
//
// Raw history costs 10 credits per 100 transactions; the Enhanced API costs 100 per call. Swaps,
// launch activity and funding sources are all derived from balance changes, which raw
// transactions carry in full, so nothing here needs Helius's parsing.

interface RawTokenBalance {
  accountIndex: number
  mint: string
  owner?: string
  uiTokenAmount?: { amount?: string; decimals?: number }
}

export interface RawTransaction {
  slot: number
  blockTime: number | null
  transaction: {
    signatures: string[]
    message: { accountKeys: string[] }
  }
  meta: {
    err: unknown
    fee: number
    preBalances: number[]
    postBalances: number[]
    preTokenBalances?: RawTokenBalance[]
    postTokenBalances?: RawTokenBalance[]
    loadedAddresses?: { writable?: string[]; readonly?: string[] }
  } | null
}

export interface RawTransactionsPage {
  data: RawTransaction[]
  paginationToken: string | null
}

/**
 * One page of an address's full transactions. `fromBlockTime` is inclusive, so a caller resuming
 * from its last seen block time gets that second again and must deduplicate by signature.
 */
export async function getRawTransactionsForAddress(
  address: string,
  options: {
    sortOrder?: 'asc' | 'desc'
    limit?: number
    fromBlockTime?: number
    paginationToken?: string | null
    succeededOnly?: boolean
  } = {}
): Promise<RawTransactionsPage> {
  if (!config.helius.apiKey) return { data: [], paginationToken: null }
  const filters: Record<string, unknown> = {}
  if (options.fromBlockTime) filters.blockTime = { gte: options.fromBlockTime }
  if (options.succeededOnly !== false) filters.status = 'succeeded'
  const result = await heliusRpc<{ data?: RawTransaction[]; paginationToken?: string | null }>('getTransactionsForAddress', [
    address,
    {
      transactionDetails: 'full',
      encoding: 'json',
      maxSupportedTransactionVersion: 1,
      sortOrder: options.sortOrder ?? 'asc',
      limit: Math.min(Math.max(options.limit ?? 100, 1), 1000),
      ...(options.paginationToken ? { paginationToken: options.paginationToken } : {}),
      filters,
    },
  ])
  const data = result.data ?? []
  charge('rpc:getTransactionsForAddress:full', Math.max(1, Math.ceil(data.length / 100)) * 10)
  return { data, paginationToken: result.paginationToken ?? null }
}

/** Every account key in transaction order, including those loaded from lookup tables. */
function rawAccountKeys(tx: RawTransaction): string[] {
  return [
    ...tx.transaction.message.accountKeys,
    ...(tx.meta?.loadedAddresses?.writable ?? []),
    ...(tx.meta?.loadedAddresses?.readonly ?? []),
  ]
}

/** Net raw-unit token change per (owner, mint), from pre/post token balances. */
function rawTokenChanges(tx: RawTransaction): Array<{ owner: string; mint: string; raw: bigint; decimals: number }> {
  const byAccount = new Map<number, { owner: string; mint: string; pre: bigint; post: bigint; decimals: number }>()
  const read = (balances: RawTokenBalance[] | undefined, field: 'pre' | 'post') => {
    for (const balance of balances ?? []) {
      const entry = byAccount.get(balance.accountIndex) ?? {
        owner: balance.owner ?? '',
        mint: balance.mint,
        pre: 0n,
        post: 0n,
        decimals: Number(balance.uiTokenAmount?.decimals ?? 0),
      }
      entry[field] = BigInt(balance.uiTokenAmount?.amount ?? '0')
      if (!entry.owner && balance.owner) entry.owner = balance.owner
      byAccount.set(balance.accountIndex, entry)
    }
  }
  read(tx.meta?.preTokenBalances, 'pre')
  read(tx.meta?.postTokenBalances, 'post')
  return [...byAccount.values()]
    .filter((entry) => entry.owner && entry.post !== entry.pre)
    .map((entry) => ({ owner: entry.owner, mint: entry.mint, raw: entry.post - entry.pre, decimals: entry.decimals }))
}

/**
 * Converts a raw transaction into the Enhanced-API shape the launch analysis reads: per-account
 * native balance changes and per-owner token balance changes.
 */
export function rawToLaunchTransaction(tx: RawTransaction): LaunchTransaction {
  const keys = rawAccountKeys(tx)
  const pre = tx.meta?.preBalances ?? []
  const post = tx.meta?.postBalances ?? []
  const accountData: NonNullable<LaunchTransaction['accountData']> = keys.map((account, i) => ({
    account,
    nativeBalanceChange: Number(post[i] ?? 0) - Number(pre[i] ?? 0),
    tokenBalanceChanges: [],
  }))
  // tokenDeltas only aggregates by owner, so the changes can sit on any entry.
  const changes = rawTokenChanges(tx).map((change) => ({
    userAccount: change.owner,
    mint: change.mint,
    rawTokenAmount: { tokenAmount: change.raw.toString(), decimals: change.decimals },
  }))
  if (accountData[0]) accountData[0].tokenBalanceChanges = changes
  return {
    signature: tx.transaction.signatures[0],
    slot: tx.slot,
    timestamp: tx.blockTime ?? undefined,
    feePayer: keys[0],
    transactionError: tx.meta?.err ?? undefined,
    accountData,
  }
}

const WSOL_MINT = 'So11111111111111111111111111111111111111112'

/**
 * Normalizes a raw transaction into at most one swap of `contract`, from the fee payer's net
 * balance changes. Netting makes a self-transfer zero rather than flagging it, and collapses a
 * multi-hop route into the single trade the wallet actually made.
 */
export function normalizeRawTokenSwap(
  tx: RawTransaction,
  contract: string,
  launchedAt: number,
  solUsdPrice: number
): NormalizedSwap | null {
  const signature = tx.transaction.signatures[0]
  const blockTime = Number(tx.blockTime ?? 0)
  if (!signature || !blockTime || !tx.meta || tx.meta.err) return null
  const wallet = tx.transaction.message.accountKeys[0]
  if (!wallet) return null

  const changes = rawTokenChanges(tx).filter((change) => change.owner === wallet)
  const sum = (mint: string) =>
    changes
      .filter((change) => change.mint === mint)
      .reduce((total, change) => total + Number(change.raw) / 10 ** change.decimals, 0)
  const tokenDelta = sum(contract)
  if (tokenDelta === 0) return null
  const isBuy = tokenDelta > 0

  let quoteAmount = 0
  let quoteSymbol: NormalizedSwap['quoteSymbol'] = 'SOL'
  for (const [mint, symbol] of STABLECOINS) {
    const delta = sum(mint)
    if (isBuy ? delta < 0 : delta > 0) {
      quoteAmount = Math.abs(delta)
      quoteSymbol = symbol
      break
    }
  }
  if (quoteSymbol === 'SOL') {
    // The fee payer's lamports include the network fee, which is not part of the trade.
    const lamports = Number(tx.meta.postBalances[0] ?? 0) - Number(tx.meta.preBalances[0] ?? 0) + tx.meta.fee
    const solDelta = lamports / 1e9 + sum(WSOL_MINT)
    if (isBuy ? solDelta >= 0 : solDelta <= 0) return null
    quoteAmount = Math.abs(solDelta)
  }
  const quoteUsd = quoteSymbol === 'SOL' ? quoteAmount * solUsdPrice : quoteAmount
  if (!(quoteUsd > 0)) return null

  return {
    contract,
    walletAddress: wallet,
    signature,
    eventIndex: 0,
    side: isBuy ? 'buy' : 'sell',
    tokenAmount: Math.abs(tokenDelta),
    quoteAmount,
    quoteSymbol,
    quoteUsd,
    blockTime,
    minutesAfterLaunch: Math.max(0, Math.floor((blockTime - launchedAt) / 60)),
    suspicious: blockTime < launchedAt,
  }
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

export interface SolanaWalletEnrichment {
  /** Portfolio value in USD, or the SOL balance valued at the fallback price if that fails. */
  balance: number
  tokensHeld: number
}

/** Leaderboard balances do not need to be fresher than a day, and each page costs 100 credits. */
const WALLET_ENRICHMENT_TTL_SECONDS = 24 * 3600

/**
 * Portfolio value and token count from one pass over the Wallet API (100 credits a page). The
 * value and the count used to be two separate passes over the same pages, and nothing was cached
 * between pipeline runs.
 */
export async function getSolanaWalletEnrichment(address: string, solUsdPrice: number): Promise<SolanaWalletEnrichment> {
  const key = `helius:wallet-enrichment:v1:${address}`
  const cached = await cacheGet<SolanaWalletEnrichment>(key)
  if (cached) return cached

  const holdings = await getSolanaWalletHoldings(address)
  let enrichment: SolanaWalletEnrichment
  if (holdings) {
    enrichment = { balance: Math.round(holdings.portfolioUsd), tokensHeld: holdings.tokenCount }
  } else {
    const solBalance = await getSolanaWalletBalance(address)
    enrichment = { balance: solBalance === null ? 0 : Math.round(solBalance * solUsdPrice), tokensHeld: 0 }
  }
  await cacheSet(key, enrichment, WALLET_ENRICHMENT_TTL_SECONDS)
  return enrichment
}

async function getSolanaWalletHoldings(address: string): Promise<{ portfolioUsd: number; tokenCount: number } | null> {
  if (!config.helius.apiKey) return null

  let portfolioUsd = 0
  let tokenCount = 0
  for (let page = 1; page <= 20; page++) {
    await throttleHelius()
    const res = await heliusKeys.fetch((key) => ({
      url: `https://api.helius.xyz/v1/wallet/${address}/balances?api-key=${key}&page=${page}&limit=100`,
      init: { signal: AbortSignal.timeout(config.worker.providerRequestTimeoutMs) },
    }))
    if (!res.ok) return page === 1 ? null : { portfolioUsd, tokenCount }
    charge('wallet:balances', 100)

    const data = (await res.json()) as {
      balances?: Array<{ balance?: number; usdValue?: number | null }>
      pagination?: { hasMore?: boolean }
    }
    for (const token of data.balances ?? []) {
      if (typeof token.usdValue === 'number' && Number.isFinite(token.usdValue)) portfolioUsd += token.usdValue
      if ((token.balance ?? 0) > 0 || (token.usdValue ?? 0) > 0) tokenCount += 1
    }
    if (!data.pagination?.hasMore) break
  }
  return { portfolioUsd, tokenCount }
}

/** SOL balance via plain getBalance (1 credit) rather than the Enhanced balances endpoint (100). */
export async function getSolanaWalletBalance(address: string): Promise<number | null> {
  if (!config.helius.apiKey) return null
  try {
    const result = await heliusRpc<{ value?: number }>('getBalance', [address])
    return Number(result.value ?? 0) / 1e9
  } catch {
    return null
  }
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

// --- Launch-insider analysis ---------------------------------------------------------------

async function heliusRpc<T>(method: string, params: unknown): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    await throttleHelius()
    const res = await heliusKeys.fetch((key) => ({
      url: `${config.helius.rpcUrl}/?api-key=${key}`,
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(config.worker.providerRequestTimeoutMs),
      },
    }))
    if (res.status === 429 && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 2_000 * 2 ** attempt))
      continue
    }
    if (!res.ok) throw new Error(`Helius RPC ${method} error: ${res.status}`)
    const json = (await res.json()) as { result?: T; error?: { message?: string } }
    if (json.error) throw new Error(`Helius RPC ${method} error: ${json.error.message ?? 'unknown'}`)
    charge(`rpc:${method}`, RPC_CREDITS[method] ?? 1)
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
  charge('rpc:getTransactionsForAddress:signatures', 10)
  return result.data ?? []
}

/** Parses signatures into enhanced transactions, 100 per request. Order is not preserved. */
export async function parseTransactions<T = HeliusEnhancedTransaction>(signatures: string[]): Promise<T[]> {
  const parsed: T[] = []
  for (let index = 0; index < signatures.length; index += 100) {
    for (let attempt = 0; attempt < 4; attempt++) {
      await throttleHelius()
      const res = await heliusKeys.fetch((key) => ({
        url: `${config.helius.baseUrl}/transactions?api-key=${key}`,
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ transactions: signatures.slice(index, index + 100) }),
          signal: AbortSignal.timeout(config.worker.providerRequestTimeoutMs),
        },
      }))
      if (res.status === 429 && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 2_000 * 2 ** attempt))
        continue
      }
      if (!res.ok) throw new Error(`Helius parse error: ${res.status}`)
      charge('enhanced:parse', 100)
      parsed.push(...((await res.json()) as T[]))
      break
    }
  }
  return parsed
}

/** A wallet's first funder never changes, so a found one is kept for a year. */
const FUNDER_TTL_SECONDS = 365 * 86_400
/** A wallet with no funding inflow yet may still receive one while it has few transactions. */
const NO_FUNDER_TTL_SECONDS = 7 * 86_400

/**
 * The wallet that sent this wallet its first meaningful SOL, or null if none is found early on.
 * Reads the wallet's first 15 raw transactions in one call (10 credits) instead of listing
 * signatures and parsing them through the Enhanced API (110), and caches the answer.
 */
export async function getFundingSource(wallet: string): Promise<string | null> {
  const key = `helius:funder:v1:${wallet}`
  const cached = await cacheGet<{ funder: string | null }>(key)
  if (cached) return cached.funder

  const { data } = await getRawTransactionsForAddress(wallet, { sortOrder: 'asc', limit: 15 })
  let funder: string | null = null
  for (const tx of data) {
    if (!tx.meta) continue
    const keys = rawAccountKeys(tx)
    const index = keys.indexOf(wallet)
    if (index < 0) continue
    const delta = (i: number) => Number(tx.meta!.postBalances[i] ?? 0) - Number(tx.meta!.preBalances[i] ?? 0)
    const inflow = delta(index) + (index === 0 ? tx.meta.fee : 0)
    if (inflow < 1e7) continue
    // The sender is the account that lost the most SOL, matching a native transfer's source.
    let source = -1
    for (let i = 0; i < keys.length; i++) {
      if (i !== index && delta(i) < 0 && (source < 0 || delta(i) < delta(source))) source = i
    }
    if (source >= 0) {
      funder = keys[source]
      break
    }
  }
  await cacheSet(key, { funder }, funder ? FUNDER_TTL_SECONDS : NO_FUNDER_TTL_SECONDS)
  return funder
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

/**
 * Last activity for many wallets in one batched JSON-RPC request, so a page of wallets waits on
 * the Helius throttle once rather than once per wallet (750ms each). Wallets with no signatures,
 * or a failed lookup, are left out.
 */
export async function getLastActivityTimes(addresses: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>()
  for (let index = 0; index < addresses.length; index += 20) {
    const batch = addresses.slice(index, index + 20)
    await throttleHelius()
    const res = await heliusKeys.fetch((key) => ({
      url: `${config.helius.rpcUrl}/?api-key=${key}`,
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          batch.map((address, id) => ({ jsonrpc: '2.0', id, method: 'getSignaturesForAddress', params: [address, { limit: 1 }] }))
        ),
        signal: AbortSignal.timeout(config.worker.providerRequestTimeoutMs),
      },
    }))
    if (!res.ok) throw new Error(`Helius RPC getSignaturesForAddress batch error: ${res.status}`)
    charge('rpc:getSignaturesForAddress', batch.length)
    const body = (await res.json()) as Array<{ id: number; result?: Array<{ blockTime?: number | null }> }>
    for (const entry of Array.isArray(body) ? body : []) {
      const blockTime = entry.result?.[0]?.blockTime
      if (blockTime) result.set(batch[entry.id], blockTime)
    }
  }
  return result
}

// --- Token scanner ---------------------------------------------------------------------------

export interface MintSecurity {
  decimals: number
  supply: number
  mintAuthority: string | null
  freezeAuthority: string | null
  /** Token-2022 transfer fee in basis points, or 0. */
  transferFeeBps: number
  transferFeeAuthority: string | null
  permanentDelegate: string | null
}

/** Supply and control settings of a mint, including Token-2022 extensions. */
export async function getMintSecurity(mint: string): Promise<MintSecurity | null> {
  const result = await heliusRpc<{ value?: { data?: { parsed?: { info?: Record<string, unknown> } } } | null }>(
    'getAccountInfo',
    [mint, { encoding: 'jsonParsed' }]
  )
  const info = result.value?.data?.parsed?.info
  if (!info) return null
  type Extension = { extension?: string; state?: Record<string, any> }
  const extensions = (info.extensions as Extension[] | undefined) ?? []
  const fee = extensions.find((e) => e.extension === 'transferFeeConfig')?.state
  const delegate = extensions.find((e) => e.extension === 'permanentDelegate')?.state
  const decimals = Number(info.decimals ?? 0)
  return {
    decimals,
    supply: Number(info.supply ?? 0) / 10 ** decimals,
    mintAuthority: (info.mintAuthority as string | null) ?? null,
    freezeAuthority: (info.freezeAuthority as string | null) ?? null,
    transferFeeBps: Number(fee?.newerTransferFee?.transferFeeBasisPoints ?? 0),
    transferFeeAuthority: (fee?.transferFeeConfigAuthority as string | null) ?? null,
    permanentDelegate: (delegate?.delegate as string | null) ?? null,
  }
}

export interface TokenHolder {
  owner: string
  amount: number
  /** True when the owner is a program account (pool, vault, launchpad) rather than a wallet. */
  isProgramOwned: boolean
  solBalance: number
}

/** The 20 largest holders of a token, resolved from token accounts to their owners. */
export async function getLargestHolders(mint: string): Promise<TokenHolder[]> {
  const largest = await heliusRpc<{ value?: Array<{ address: string; uiAmount?: number | null }> }>(
    'getTokenLargestAccounts',
    [mint]
  )
  const accounts = largest.value ?? []
  if (accounts.length === 0) return []
  const tokenAccounts = await heliusRpc<{ value?: Array<{ data?: { parsed?: { info?: { owner?: string } } } } | null> }>(
    'getMultipleAccounts',
    [accounts.map((a) => a.address), { encoding: 'jsonParsed' }]
  )
  const owners = (tokenAccounts.value ?? []).map((a) => a?.data?.parsed?.info?.owner ?? '')
  const uniqueOwners = [...new Set(owners.filter(Boolean))]
  const ownerAccounts = await heliusRpc<{ value?: Array<{ owner?: string; lamports?: number } | null> }>(
    'getMultipleAccounts',
    [uniqueOwners, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]
  )
  const ownerInfo = new Map<string, { owner?: string; lamports?: number } | null>()
  uniqueOwners.forEach((owner, i) => ownerInfo.set(owner, ownerAccounts.value?.[i] ?? null))

  // Several token accounts can share one owner, so merge by owner.
  const byOwner = new Map<string, TokenHolder>()
  accounts.forEach((account, i) => {
    const owner = owners[i]
    if (!owner) return
    const info = ownerInfo.get(owner)
    const amount = Number(account.uiAmount ?? 0)
    const existing = byOwner.get(owner)
    if (existing) {
      existing.amount += amount
      return
    }
    byOwner.set(owner, {
      owner,
      amount,
      isProgramOwned: Boolean(info?.owner && info.owner !== '11111111111111111111111111111111'),
      solBalance: Number(info?.lamports ?? 0) / 1e9,
    })
  })
  return [...byOwner.values()].sort((a, b) => b.amount - a.amount)
}

/** How much of one token a wallet holds now, across all its token accounts. */
export async function getOwnerTokenBalance(mint: string, owner: string, decimals: number): Promise<number> {
  const result = await heliusRpc<{ token_accounts?: Array<{ amount?: number }> }>('getTokenAccounts', { mint, owner, limit: 10 })
  return (result.token_accounts ?? []).reduce((sum, account) => sum + Number(account.amount ?? 0), 0) / 10 ** decimals
}

/** A token's image from its on-chain metadata, for tokens Dexscreener has no image for. */
export async function getTokenImage(mint: string): Promise<string | null> {
  const asset = await heliusRpc<{
    content?: { links?: { image?: string }; files?: Array<{ uri?: string; cdn_uri?: string }> }
  }>('getAsset', { id: mint })
  return asset.content?.links?.image || asset.content?.files?.[0]?.cdn_uri || asset.content?.files?.[0]?.uri || null
}
