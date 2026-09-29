/**
 * "What are the top traders buying right now?"
 *
 * Given each tracked wallet's recent swaps, works out which tokens it is net buying and ranks
 * tokens by how many tracked wallets are in them. The wallets themselves come from FOMO's
 * leaderboards (see fomo-traders.ts).
 */

/**
 * Tokens that are money rather than positions: the native coin, its wrapped form, stablecoins
 * and liquid-staked variants. A wallet swapping into these is taking profit, not buying.
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

/** Robinhood Chain quote assets, lowercased because EVM addresses are case-insensitive. */
export const ROBINHOOD_QUOTE_ASSETS = new Set(
  [
    '0x0000000000000000000000000000000000000000', // ETH (native)
    '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', // ETH (aggregator placeholder)
    '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', // WETH
    '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', // USDG
    // Tokenized 0-3 month Treasury ETF: a place to park cash, not a trade.
    '0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5', // SGOV
  ].map((address) => address.toLowerCase())
)

/** True when an address is a quote asset on the given chain. */
export function isQuoteAsset(chain: string, address: string): boolean {
  return chain === 'solana' ? QUOTE_ASSETS.has(address) : ROBINHOOD_QUOTE_ASSETS.has(address.toLowerCase())
}

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
export function summarizeWalletFlows(swaps: Swap[], chain = 'solana'): Map<string, TokenFlow> {
  const flows = new Map<string, TokenFlow>()
  for (const swap of swaps) {
    const usd = Number.isFinite(swap.volumeUsd) ? Math.max(0, swap.volumeUsd) : 0
    for (const side of [swap.base, swap.quote]) {
      if (!side.address || isQuoteAsset(chain, side.address) || side.uiChangeAmount === 0) continue
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
