/**
 * "What are the most profitable wallets buying right now?"
 *
 * Birdeye's 30-day profit leaderboard is mostly noise at the top. Sorted by total PnL, the
 * leaders are one-trade wallets holding millions in unrealizable paper gains (token creators and
 * snipers on illiquid launches). Sorted by realized PnL, the leaders show +$42M realized offset
 * by -$42M unrealized, i.e. accounting artifacts with a total PnL near zero. The wallets worth
 * following are the ones whose profit is real and already taken: total and realized PnL agree.
 * In a sample of the top 200 by each sort, 18 wallets passed that test.
 */

export interface TraderStats {
  address: string
  pnl: number
  realizedPnl: number
  volume: number
  trades: number
}

/** True when a leaderboard wallet's profit is real, taken, and not a one-off. */
export function isProfitableTrader(trader: TraderStats, minTrades: number): boolean {
  if (!trader.address || trader.pnl <= 0 || trader.realizedPnl <= 0) return false
  if (trader.trades < minTrades) return false
  // Most of the profit must be realized, and unrealized losses must not cancel it out.
  return trader.realizedPnl >= trader.pnl * 0.5 && trader.pnl >= trader.realizedPnl * 0.5
}

export const SYSTEM_PROGRAM = '11111111111111111111111111111111'

/**
 * True when an address is a wallet someone can still trade from. The leaderboard includes
 * addresses that no longer exist (burner wallets drained and closed after use: 22 of the first
 * 50 picks), accounts owned by programs rather than people, and wallets left with dust. None of
 * those will trade again, so following them shows nothing.
 */
export function isLiveTradingWallet(
  account: { owner: string; lamports: number } | undefined,
  lastActivity: number | null,
  opts: { minSol: number; maxIdleDays: number; now: number }
): boolean {
  if (!account || account.owner !== SYSTEM_PROGRAM) return false
  if (account.lamports / 1e9 < opts.minSol) return false
  if (lastActivity === null) return false
  return opts.now - lastActivity <= opts.maxIdleDays * 86_400
}

/** Picks the top wallets by realized profit from one or more leaderboard pages. */
export function selectSmartWallets<T extends TraderStats>(traders: T[], minTrades: number, limit: number): T[] {
  const unique = new Map<string, T>()
  for (const trader of traders) {
    if (isProfitableTrader(trader, minTrades) && !unique.has(trader.address)) unique.set(trader.address, trader)
  }
  return [...unique.values()].sort((a, b) => b.realizedPnl - a.realizedPnl).slice(0, limit)
}

/**
 * Tokens that are money rather than positions: SOL, stablecoins and liquid-staked SOL. A wallet
 * swapping into these is taking profit, not buying.
 */
export const QUOTE_ASSETS = new Set([
  'So11111111111111111111111111111111111111112', // wSOL
  'So11111111111111111111111111111111111111111', // native SOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD5kj5YKEj8K1GmJ6eDqGf', // USDT
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT (canonical)
  'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB', // USD1
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', // PYUSD
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', // mSOL
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', // JitoSOL
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', // bSOL
  'jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v', // JupSOL
  'BNso1VUJnh4zcfpZa6986Ea66P6TCp59hvtNJ8b1X85', // BNSOL
  '5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm', // INF
  'he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A', // hSOL
  'Dso1bDeDjCQxTrWHqUUi63oBvV7Mdm6WaobLbQ7gnPQ', // dSOL
  'vSoLxydx6akxyMD9XEcPvGYNGq6Nn66oqVb3UkGkei7', // vSOL
  '7Q2afV64in6N6SeZsAAB81TJzwDoD6zpqmHkzi9Dcavn', // JSOL
  '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj', // stSOL
  'LSTxxxnJzKDFSLr4dUkPcmCf5VyryEqzPLz5j4bpxFp', // LST
])

export interface SwapSide {
  address: string
  symbol: string
  uiChangeAmount: number
}

export interface Swap {
  blockTime: number
  volumeUsd: number
  base: SwapSide
  quote: SwapSide
}

export interface TokenFlow {
  contract: string
  symbol: string
  buyUsd: number
  sellUsd: number
  buys: number
  sells: number
  firstBuyAt: number
  lastBuyAt: number
}

/** Per-token buy and sell totals for one wallet's swaps. */
export function summarizeWalletFlows(swaps: Swap[]): Map<string, TokenFlow> {
  const flows = new Map<string, TokenFlow>()
  for (const swap of swaps) {
    const usd = Number.isFinite(swap.volumeUsd) ? Math.max(0, swap.volumeUsd) : 0
    for (const side of [swap.base, swap.quote]) {
      if (!side.address || QUOTE_ASSETS.has(side.address) || side.uiChangeAmount === 0) continue
      const flow = flows.get(side.address) ?? {
        contract: side.address,
        symbol: side.symbol,
        buyUsd: 0,
        sellUsd: 0,
        buys: 0,
        sells: 0,
        firstBuyAt: 0,
        lastBuyAt: 0,
      }
      if (side.uiChangeAmount > 0) {
        flow.buyUsd += usd
        flow.buys += 1
        flow.firstBuyAt = flow.firstBuyAt ? Math.min(flow.firstBuyAt, swap.blockTime) : swap.blockTime
        flow.lastBuyAt = Math.max(flow.lastBuyAt, swap.blockTime)
      } else {
        flow.sellUsd += usd
        flow.sells += 1
      }
      if (!flow.symbol) flow.symbol = side.symbol
      flows.set(side.address, flow)
    }
  }
  return flows
}

export interface WalletBuy {
  wallet: string
  netBuyUsd: number
  lastBuyAt: number
}

export interface TokenBuying {
  contract: string
  symbol: string
  walletCount: number
  buyUsd: number
  sellUsd: number
  netBuyUsd: number
  buyCount: number
  firstBuyAt: number
  lastBuyAt: number
  /** Combined 30-day realized profit of the wallets buying. Ranks ties on wallet count. */
  buyerRealizedPnl: number
  /** Net-buying wallets, largest net buy first. */
  wallets: WalletBuy[]
}

/**
 * Tokens the tracked wallets are net buying, ranked by how many of them are in it, then by how
 * profitable those wallets are, then by how much they bought. Three top-20 traders in a token
 * outrank three wallets from the bottom of the list. A wallet that bought and then sold more
 * than it bought is exiting, so only net buys of at least `minNetBuyUsd` count.
 */
export function aggregateBuying(
  walletFlows: Map<string, Map<string, TokenFlow>>,
  minNetBuyUsd: number,
  walletProfit: Map<string, number> = new Map()
): TokenBuying[] {
  const tokens = new Map<string, TokenBuying>()
  for (const [wallet, flows] of walletFlows) {
    for (const flow of flows.values()) {
      const net = flow.buyUsd - flow.sellUsd
      if (net < minNetBuyUsd || flow.buys === 0) continue
      const token = tokens.get(flow.contract) ?? {
        contract: flow.contract,
        symbol: flow.symbol,
        walletCount: 0,
        buyUsd: 0,
        sellUsd: 0,
        netBuyUsd: 0,
        buyCount: 0,
        firstBuyAt: flow.firstBuyAt,
        lastBuyAt: 0,
        buyerRealizedPnl: 0,
        wallets: [],
      }
      token.walletCount += 1
      token.buyUsd += flow.buyUsd
      token.sellUsd += flow.sellUsd
      token.netBuyUsd += net
      token.buyCount += flow.buys
      token.firstBuyAt = Math.min(token.firstBuyAt, flow.firstBuyAt)
      token.lastBuyAt = Math.max(token.lastBuyAt, flow.lastBuyAt)
      token.buyerRealizedPnl += walletProfit.get(wallet) ?? 0
      token.wallets.push({ wallet, netBuyUsd: net, lastBuyAt: flow.lastBuyAt })
      tokens.set(flow.contract, token)
    }
  }
  for (const token of tokens.values()) token.wallets.sort((a, b) => b.netBuyUsd - a.netBuyUsd)
  return [...tokens.values()].sort(
    (a, b) =>
      b.walletCount - a.walletCount || b.buyerRealizedPnl - a.buyerRealizedPnl || b.netBuyUsd - a.netBuyUsd
  )
}
