const BASE_URL = 'https://api.dexscreener.com'
const MAX_BATCH_SIZE = 30

interface DexToken {
  address?: string
  name?: string
  symbol?: string
}

export interface DexPair {
  chainId?: string
  pairAddress?: string
  url?: string
  baseToken?: DexToken
  priceUsd?: string
  fdv?: number
  marketCap?: number
  liquidity?: { usd?: number }
  volume?: { h24?: number }
  priceChange?: { h24?: number }
  info?: { imageUrl?: string }
}

export interface TokenMarketHealth {
  contract: string
  pairAddress: string
  pairUrl: string
  pairCount: number
  price: number
  marketCap: number
  fdv: number
  liquidity: number
  volume24h: number
  priceChange24h: number
}

function number(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Dexscreener chain slugs match ours: solana, robinhood. */
async function fetchBatch(addresses: string[], chain = 'solana'): Promise<DexPair[]> {
  const path = addresses.map(encodeURIComponent).join(',')
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(`${BASE_URL}/tokens/v1/${encodeURIComponent(chain)}/${path}`, {
        signal: AbortSignal.timeout(15_000),
      })
      if (response.status === 429 && attempt < 2) {
        await sleep(1_000 * 2 ** attempt)
        continue
      }
      if (!response.ok) throw new Error(`Dexscreener API error ${response.status}`)
      const body = (await response.json()) as unknown
      return Array.isArray(body) ? (body as DexPair[]) : []
    } catch (error) {
      if (attempt === 2) throw error
      await sleep(1_000 * 2 ** attempt)
    }
  }
  return []
}

export function selectTokenMarketHealth(
  contract: string,
  pairs: DexPair[],
  chain = 'solana'
): TokenMarketHealth | null {
  const contractLower = contract.toLowerCase()
  const matches = pairs.filter(
    (pair) =>
      pair.chainId === chain &&
      pair.baseToken?.address?.toLowerCase() === contractLower
  )
  if (matches.length === 0) return null

  const primary = [...matches].sort(
    (left, right) => number(right.liquidity?.usd) - number(left.liquidity?.usd)
  )[0]
  return {
    contract,
    pairAddress: primary.pairAddress ?? '',
    pairUrl: primary.url ?? `https://dexscreener.com/${chain}/${contract}`,
    pairCount: matches.length,
    price: number(primary.priceUsd),
    marketCap: number(primary.marketCap),
    fdv: number(primary.fdv),
    liquidity: matches.reduce((sum, pair) => sum + number(pair.liquidity?.usd), 0),
    volume24h: matches.reduce((sum, pair) => sum + number(pair.volume?.h24), 0),
    priceChange24h: number(primary.priceChange?.h24),
  }
}

export async function getTokenMarketHealth(
  chain: string,
  addresses: string[]
): Promise<Map<string, TokenMarketHealth>> {
  const unique = [...new Set(addresses.filter(Boolean))]
  const result = new Map<string, TokenMarketHealth>()
  for (let index = 0; index < unique.length; index += MAX_BATCH_SIZE) {
    const batch = unique.slice(index, index + MAX_BATCH_SIZE)
    const pairs = await fetchBatch(batch, chain)
    for (const address of batch) {
      const health = selectTokenMarketHealth(address, pairs, chain)
      if (health) result.set(address, health)
    }
    if (index + MAX_BATCH_SIZE < unique.length) await sleep(250)
  }
  return result
}

export interface DexTokenInfo {
  name: string
  symbol: string
  imageUrl: string
}

/**
 * Name, symbol and logo per token, from the pairs Dexscreener lists for it. Keys are the
 * addresses as requested: EVM addresses can come back in a different letter case.
 */
export async function getTokenInfo(chain: string, addresses: string[]): Promise<Map<string, DexTokenInfo>> {
  const unique = [...new Set(addresses.filter(Boolean))]
  const requested = new Map(unique.map((address) => [address.toLowerCase(), address]))
  const result = new Map<string, DexTokenInfo>()
  for (let index = 0; index < unique.length; index += MAX_BATCH_SIZE) {
    const pairs = await fetchBatch(unique.slice(index, index + MAX_BATCH_SIZE), chain)
    for (const pair of pairs) {
      const address = requested.get(pair.baseToken?.address?.toLowerCase() ?? '')
      if (!address || pair.chainId !== chain) continue
      const existing = result.get(address)
      if (existing?.imageUrl) continue
      result.set(address, {
        name: pair.baseToken?.name || existing?.name || '',
        symbol: pair.baseToken?.symbol || existing?.symbol || '',
        imageUrl: pair.info?.imageUrl || '',
      })
    }
    if (index + MAX_BATCH_SIZE < unique.length) await sleep(250)
  }
  return result
}

export function getSolanaTokenMarketHealth(addresses: string[]): Promise<Map<string, TokenMarketHealth>> {
  return getTokenMarketHealth('solana', addresses)
}
