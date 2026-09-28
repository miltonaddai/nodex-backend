import { config } from '../config'

/**
 * Blockscout's hosted API, for Robinhood Chain holder counts. Birdeye returns holder as null on
 * this chain, and the churn screen divides by it. The public explorer sits behind a bot check,
 * so this uses the keyed gateway.
 */
const CHAIN_IDS: Record<string, number> = { robinhood: 4663 }
const MIN_INTERVAL_MS = 250

let lastCall = 0

async function throttle(): Promise<void> {
  const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastCall))
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
  lastCall = Date.now()
}

export function isBlockscoutConfigured(chain: string): boolean {
  return Boolean(config.blockscout.apiKey && CHAIN_IDS[chain])
}

/** Holder count for one token, or null when Blockscout does not know it. */
export async function getHolderCount(chain: string, token: string): Promise<number | null> {
  const chainId = CHAIN_IDS[chain]
  if (!chainId || !config.blockscout.apiKey) return null
  await throttle()
  const res = await fetch(`https://api.blockscout.com/${chainId}/api/v2/tokens/${encodeURIComponent(token)}`, {
    headers: { Authorization: `Bearer ${config.blockscout.apiKey}` },
    signal: AbortSignal.timeout(config.worker.providerRequestTimeoutMs),
  })
  if (!res.ok) return null
  const body = (await res.json()) as { holders_count?: string | number | null }
  const holders = Number(body.holders_count)
  return Number.isFinite(holders) && holders > 0 ? holders : null
}

/** Holder counts for many tokens. Tokens Blockscout does not know are left out. */
export async function getHolderCounts(chain: string, tokens: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>()
  for (const token of tokens) {
    try {
      const holders = await getHolderCount(chain, token)
      if (holders !== null) result.set(token, holders)
    } catch {
      // One missing token should not stop the rest.
    }
  }
  return result
}
