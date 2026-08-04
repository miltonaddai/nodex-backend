const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

export function isValidSolanaAddress(address: string): boolean {
  return SOLANA_ADDRESS_RE.test(address)
}

export interface TokenValidationOptions {
  minLiquidity: number
  minVolume: number
  minMarketCap: number
  minHolders: number
}

export interface RawTokenRow {
  address: string
  name: string
  symbol: string
  price: number
  marketCap: number
  changePct: number
  volume: number
  liquidity: number
  holders: number
}

export function validateTokenRow(row: RawTokenRow, opts: TokenValidationOptions): boolean {
  return getTokenRejectionReason(row, opts) === null
}

export function getTokenRejectionReason(row: RawTokenRow, opts: TokenValidationOptions): string | null {
  if (!isValidSolanaAddress(row.address)) return 'invalid_address'
  if (!row.name?.trim() || !row.symbol?.trim()) return 'missing_name_or_symbol'
  if (!Number.isFinite(row.price) || row.price <= 0) return 'invalid_price'
  if (!Number.isFinite(row.marketCap) || row.marketCap < opts.minMarketCap) return 'low_market_cap'
  if (!Number.isFinite(row.liquidity) || row.liquidity < opts.minLiquidity) return 'low_liquidity'
  if (!Number.isFinite(row.volume) || row.volume < opts.minVolume) return 'low_volume'
  if (!Number.isFinite(row.holders) || row.holders < 0) return 'invalid_holders'
  // Birdeye tokenlist often omits holder counts (0). Only enforce when data is present.
  if (row.holders > 0 && row.holders < opts.minHolders) return 'low_holders'
  if (!Number.isFinite(row.changePct)) return 'invalid_change'
  return null
}

export interface WalletValidationOptions {
  minTrades: number
  minVolumeUsd: number
  minBalanceUsd: number
  minWinRate: number
  maxProfitToVolumeRatio: number
}

export interface RawWalletRow {
  address: string
  balance: number
  totalProfit: number
  winRate: number
  trades: number
  volume: number
  lastActive: string
}

export function getWalletRejectionReason(row: RawWalletRow, opts: WalletValidationOptions): string | null {
  if (!isValidSolanaAddress(row.address)) return 'invalid_address'
  if (!Number.isFinite(row.totalProfit) || row.totalProfit <= 0) return 'non_positive_profit'
  if (!Number.isFinite(row.winRate) || row.winRate < 0 || row.winRate > 100) return 'invalid_win_rate'
  if (row.winRate > 0 && row.winRate < opts.minWinRate) return 'low_win_rate'
  if (!Number.isFinite(row.trades) || row.trades < opts.minTrades) return 'low_trades'
  if (!Number.isFinite(row.volume) || row.volume < opts.minVolumeUsd) return 'low_volume'
  if (!Number.isFinite(row.balance) || row.balance < opts.minBalanceUsd) return 'low_balance'
  if (row.volume > 0 && row.totalProfit / row.volume > opts.maxProfitToVolumeRatio) return 'suspicious_pnl_ratio'
  if (!row.lastActive?.trim()) return 'missing_last_active'
  return null
}

export function validateWalletRow(row: RawWalletRow, opts: WalletValidationOptions): boolean {
  return getWalletRejectionReason(row, opts) === null
}
