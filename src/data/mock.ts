export interface WalletRow {
  rank: number
  address: string
  balance: number
  totalProfit: number
  winRate: number
  trades: number
  volume: number
  tokensHeld: number
  lastActive: string
}

export interface TokenRow {
  rank: number
  name: string
  symbol: string
  imageUrl?: string
  contract: string
  price: number
  marketCap: number
  changePct: number
  volume: number
  holders: number
  // Optional alpha fields. Only the ClickHouse-backed rows carry these; the mock rows below
  // mostly omit them, which is why the token watchlist falls back to placeholder metrics.
  liquidity?: number
  churn?: number
  launchedAt?: string
  ageDays?: number
}

export interface WatchlistWallet {
  id: string
  name: string
  address: string
  /** USD. Null when it could not be measured for this wallet. */
  balance: number | null
  pnl7d: number | null
  /** Percent, 0-100. Null on Robinhood Chain, where no per-wallet trade history is available. */
  winRate: number | null
  lastActive: string | null
  chain: string
  /** Set when the wallet belongs to a tracked FOMO trader. */
  handle?: string | null
  displayName?: string | null
  avatarUrl?: string | null
  // True when the wallet is on the watchlist but has no row in wallet_analytics, so the
  // metrics below are placeholders rather than measured zeros.
  analyticsUnavailable?: boolean
}

const SOLANA_WALLETS = [
  '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
  '3nF8k2WmZqR4pL7vX9cHjN5tYbW6sDaE1fG8hK2mZ2k',
  '9pQr5sTu7vWx2yZa4bCd6eFg8hIj0kLm2nOp4qRs6tUv',
  '2mNo4pQr6sTu8vWx0yZa3bCd5eFg7hIj9kLm1nOp3qRs',
  '5tUv7wXy9zAb1cDe3fGh5iJk7lMn9oPq1rSt3uVw5xYz',
  '8hIj0kLm2nOp4qRs6tUv8wXy0zAb2cDe4fGh6iJk8lMn',
  '1nOp3qRs5tUv7wXy9zAb0cDe2fGh4iJk6lMn8oPq0rSt',
  '4qRs6tUv8wXy0zAb2cDe4fGh6iJk8lMn0oPq2rSt4uVw',
  '7wXy9zAb1cDe3fGh5iJk7lMn9oPq1rSt3uVw5xYz7aBc',
  '0zAb2cDe4fGh6iJk8lMn0oPq2rSt4uVw6xYz8aBc0dEf',
]

const TOKEN_DATA = [
  { name: 'Nyan Frog', symbol: 'FROG', contract: '8xKp2mNq4rSt6uVw8yZa0bCd2eFg4hIj6kLm8nOp0qRs' },
  { name: 'Sol Ghost', symbol: 'GHOST', contract: '3nF8k2WmZqR4pL7vX9cHjN5tYbW6sDaE1fG8hK2mZ2k' },
  { name: 'Moon Cat', symbol: 'MCAT', contract: '9pQr5sTu7vWx2yZa4bCd6eFg8hIj0kLm2nOp4qRs6tUv' },
  { name: 'Degen Ape', symbol: 'DAPE', contract: '2mNo4pQr6sTu8vWx0yZa3bCd5eFg7hIj9kLm1nOp3qRs' },
  { name: 'Pixel Dog', symbol: 'PDOG', contract: '5tUv7wXy9zAb1cDe3fGh5iJk7lMn9oPq1rSt3uVw5xYz' },
  { name: 'Pump Wizard', symbol: 'WZRD', contract: '8hIj0kLm2nOp4qRs6tUv8wXy0zAb2cDe4fGh6iJk8lMn' },
  { name: 'Turbo Fish', symbol: 'FISH', contract: '1nOp3qRs5tUv7wXy9zAb0cDe2fGh4iJk6lMn8oPq0rSt' },
  { name: 'Alpha Bear', symbol: 'BEAR', contract: '4qRs6tUv8wXy0zAb2cDe4fGh6iJk8lMn0oPq2rSt4uVw' },
  { name: 'Rocket Fox', symbol: 'RFOX', contract: '7wXy9zAb1cDe3fGh5iJk7lMn9oPq1rSt3uVw5xYz7aBc' },
  { name: 'Chain Owl', symbol: 'OWL', contract: '0zAb2cDe4fGh6iJk8lMn0oPq2rSt4uVw6xYz8aBc0dEf' },
]

const WATCHLIST_NAMES = [
  'Whale Hunter',
  'Smart Money #1',
  'Alpha Trader',
  'Degen King',
  'Sol Sniper',
  'Moon Walker',
]

const LAST_ACTIVE = ['2m ago', '15m ago', '1h ago', '3h ago', '6h ago', '1d ago', '2d ago', '3d ago']

export function getMockTopWallets(chain: string, period: string): WalletRow[] {
  const periodMultiplier = period === '24H' ? 0.35 : period === '30D' ? 1.3 : period === 'All' ? 1.8 : 1
  return SOLANA_WALLETS.map((address, i) => ({
    rank: i + 1,
    address: chain === 'robinhood' ? `0x${address.slice(0, 40)}` : address,
    balance: Math.round(612400 - i * 45000 + Math.random() * 20000),
    totalProfit: Math.round((284500 - i * 22000 + Math.random() * 10000) * periodMultiplier),
    winRate: Math.round(78 - i * 3 + Math.random() * 5),
    trades: Math.round((342 - i * 25 + Math.random() * 20) * periodMultiplier),
    volume: Math.round((1200000 - i * 80000) * periodMultiplier),
    tokensHeld: Math.round(12 + (i % 8) * 3 + Math.random() * 5),
    lastActive: LAST_ACTIVE[i % LAST_ACTIVE.length],
  }))
}

export function getMockTopTokens(_chain: string, period: string): TokenRow[] {
  const periodMultiplier = period === '24H' ? 0.4 : period === '30D' ? 1.2 : period === 'All' ? 1.5 : 1
  return Array.from({ length: 40 }, (_, i) => {
    const seed = TOKEN_DATA[i % TOKEN_DATA.length]
    return {
      rank: i + 1,
      name: i < TOKEN_DATA.length ? seed.name : `${seed.name} ${Math.floor(i / TOKEN_DATA.length) + 1}`,
      symbol: i < TOKEN_DATA.length ? seed.symbol : `${seed.symbol}${i}`,
      contract: `${seed.contract.slice(0, 32)}${i.toString().padStart(4, '0')}`,
      price: parseFloat((0.00184 + (i % 10) * 0.0003).toFixed(5)),
      marketCap: Math.round((1840000 - (i % 10) * 140000) * periodMultiplier),
      changePct: i % 11 === 5 ? -42 : Math.round((340 - (i % 10) * 45) * periodMultiplier),
      volume: Math.round((612000 - (i % 10) * 50000) * periodMultiplier),
      holders: Math.round(3200 - (i % 10) * 200),
    }
  })
}

export function getMockWatchlist(chain: string): WatchlistWallet[] {
  return WATCHLIST_NAMES.map((name, i) => ({
    id: `wl-${i + 1}`,
    name,
    address: SOLANA_WALLETS[i],
    balance: Math.round(612400 - i * 80000),
    pnl7d: i === 2 ? -12300 : Math.round(84200 - i * 12000),
    winRate: Math.round(78 - i * 5),
    lastActive: LAST_ACTIVE[i],
    chain,
  }))
}

// In-memory store for demo auth when Supabase is not configured
export const demoUsers = new Map<string, { id: string; email: string; password: string }>()
export const demoWatchlist = new Map<string, WatchlistWallet[]>()
// `${userId}:${chain}` entries whose demo list is authoritative — the seeded mock
// wallets must not come back once the user has edited or removed any of them.
export const demoSeededChains = new Set<string>()
