import { chainLabel } from './chains'

/** The token fields an alert message shows. */
export interface AlertToken {
  contract: string
  symbol: string
  name: string
  walletCount: number
  marketCap: number
  priceChange24h: number
}

/** At most this many tokens are listed in one message; the rest are counted. */
export const MAX_LISTED = 8

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** $480K, $1.2M, $850. */
export function compactUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0'
  const units: Array<[number, string]> = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ]
  for (const [size, suffix] of units) {
    if (value >= size) return `$${Number((value / size).toFixed(value / size < 10 ? 1 : 0))}${suffix}`
  }
  return `$${Math.round(value)}`
}

export function dexscreenerUrl(chain: string, contract: string): string {
  return `https://dexscreener.com/${encodeURIComponent(chain)}/${encodeURIComponent(contract)}`
}

/**
 * The Telegram message for one alert on one chain: a title line, then each new token with its top
 * trader count, market cap and 24h move, linked to its chart. HTML parse mode.
 */
export function formatAlertMessage(title: string, chain: string, tokens: AlertToken[]): string {
  const listed = tokens.slice(0, MAX_LISTED)
  const lines = listed.map((token) => {
    const label = escape(token.symbol || token.name || token.contract.slice(0, 6))
    const change = Number.isFinite(token.priceChange24h)
      ? ` · ${token.priceChange24h >= 0 ? '+' : ''}${token.priceChange24h.toFixed(1)}% 24h`
      : ''
    const traders = `${token.walletCount} top trader${token.walletCount === 1 ? '' : 's'}`
    return `<a href="${dexscreenerUrl(chain, token.contract)}"><b>${label}</b></a> · ${traders} · ${compactUsd(token.marketCap)} mcap${change}`
  })
  const more = tokens.length > MAX_LISTED ? `\n…and ${tokens.length - MAX_LISTED} more` : ''
  const count = tokens.length === 1 ? '1 new token' : `${tokens.length} new tokens`
  return `🐋 <b>${escape(title)}</b> · ${escape(chainLabel(chain))}\n${count}\n\n${lines.join('\n')}${more}`
}
