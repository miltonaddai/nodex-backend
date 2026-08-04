/// <reference types="node" />
import { config } from '../src/config'

/**
 * Can Alchemy give us a holder count for a Robinhood ERC-20?
 *
 * Birdeye returns holder as null on this chain, which makes churn uncomputable. Tests whether
 * transfers can be enumerated per contract so unique recipients could stand in as a denominator.
 */
const STONKBROKER = '0xe934e36A439C94017B64a3FecE66AF12099aBF50'

async function rpc(method: string, params: unknown[]): Promise<Record<string, unknown>> {
  const res = await fetch(config.alchemy.robinhoodUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const text = await res.text()
  try {
    return { status: res.status, ...(JSON.parse(text) as Record<string, unknown>) }
  } catch {
    return { status: res.status, raw: text.slice(0, 200) }
  }
}

async function main() {
  if (!config.alchemy.robinhoodUrl) {
    console.log('NO_URL')
    process.exit(0)
  }

  // Does the node answer at all?
  const block = await rpc('eth_blockNumber', [])
  console.log('BLOCK', JSON.stringify(block).slice(0, 160))

  // Can we enumerate transfers for a single ERC-20 contract?
  const transfers = await rpc('alchemy_getAssetTransfers', [
    {
      fromBlock: '0x0',
      toBlock: 'latest',
      contractAddresses: [STONKBROKER],
      category: ['erc20'],
      maxCount: '0x64',
      withMetadata: false,
    },
  ])
  const result = transfers.result as { transfers?: Record<string, unknown>[]; pageKey?: string } | undefined
  if (transfers.error) {
    console.log('TRANSFERS_ERROR', JSON.stringify(transfers.error).slice(0, 300))
  } else {
    const list = result?.transfers ?? []
    const recipients = new Set(list.map((t) => String(t.to ?? '')).filter(Boolean))
    console.log(
      'TRANSFERS',
      JSON.stringify({
        returned: list.length,
        unique_recipients_in_page: recipients.size,
        has_page_key: Boolean(result?.pageKey),
        sample_fields: list[0] ? Object.keys(list[0]).sort() : [],
      })
    )
  }

  // Is there any direct holder endpoint on this chain?
  for (const method of ['alchemy_getTokenMetadata', 'alchemy_getOwnersForToken']) {
    const probe = await rpc(method, [STONKBROKER])
    console.log(method, JSON.stringify(probe).slice(0, 200))
  }
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
