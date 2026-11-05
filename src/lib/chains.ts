/**
 * Chains WhaleMo covers. Solana gets the full pipeline. The EVM chains get discovery, market
 * health, the scanner and smart money (FOMO's trade feed), but no trade ingestion, wallet
 * scoring or bundle detection.
 */
export const SUPPORTED_CHAINS = ['solana', 'robinhood', 'bsc'] as const

export type SupportedChain = (typeof SUPPORTED_CHAINS)[number]

/** EVM chains: 0x addresses, lowercased for comparison, and the trader's EVM wallet. */
export const EVM_CHAINS = new Set<string>(['robinhood', 'bsc'])

const LABELS: Record<SupportedChain, string> = {
  solana: 'Solana',
  robinhood: 'Robinhood Chain',
  bsc: 'BNB Chain',
}

/** Watchlist filter value meaning every chain. */
export const ALL_CHAINS = 'all'

export function isSupportedChain(chain: string): chain is SupportedChain {
  return (SUPPORTED_CHAINS as readonly string[]).includes(chain)
}

export function chainLabel(chain: string): string {
  return isSupportedChain(chain) ? LABELS[chain] : chain
}

/** "Solana, Robinhood Chain and BNB Chain", for coverage messages. */
export function coveredChainsText(): string {
  const labels = SUPPORTED_CHAINS.map((chain) => LABELS[chain])
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
}
