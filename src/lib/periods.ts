export const PERIODS = ['24H', '7D', '30D', 'All'] as const
export type PeriodLabel = (typeof PERIODS)[number]

export interface PeriodConfig {
  label: PeriodLabel
  days: number
  birdeyeWalletType: 'today' | '1W' | '30d' | '90d'
  birdeyePnlDuration: '24h' | '7d' | '30d' | '90d' | 'all'
  tokenSortBy: string
  tokenChangeField: string
  tokenVolumeField: string
}

export const PERIOD_CONFIG: Record<PeriodLabel, PeriodConfig> = {
  '24H': {
    label: '24H',
    days: 1,
    birdeyeWalletType: 'today',
    birdeyePnlDuration: '24h',
    // Fetch by volume — sort_by=mc returns manipulated tokens with fake MC and ~$0 liquidity.
    tokenSortBy: 'v24hUSD',
    tokenChangeField: 'v24hChangePercent',
    tokenVolumeField: 'volume24h',
  },
  '7D': {
    label: '7D',
    days: 7,
    birdeyeWalletType: '1W',
    birdeyePnlDuration: '7d',
    tokenSortBy: 'v24hUSD',
    tokenChangeField: 'priceChange7d',
    tokenVolumeField: 'volume24h',
  },
  '30D': {
    label: '30D',
    days: 30,
    birdeyeWalletType: '30d',
    birdeyePnlDuration: '30d',
    tokenSortBy: 'v24hUSD',
    tokenChangeField: 'priceChange30d',
    tokenVolumeField: 'volume24h',
  },
  All: {
    label: 'All',
    days: 365,
    birdeyeWalletType: '90d',
    birdeyePnlDuration: 'all',
    tokenSortBy: 'v24hUSD',
    tokenChangeField: 'priceChange30d',
    tokenVolumeField: 'volume24h',
  },
}

export function periodToDays(period: string): number {
  return PERIOD_CONFIG[period as PeriodLabel]?.days ?? PERIOD_CONFIG['7D'].days
}

export function isValidPeriod(period: string): period is PeriodLabel {
  return period in PERIOD_CONFIG
}

export function allPeriodConfigs(): PeriodConfig[] {
  return PERIODS.map((label) => PERIOD_CONFIG[label])
}
