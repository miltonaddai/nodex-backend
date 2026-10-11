/// <reference types="node" />
// Read-only check of the BNB Chain path: discovery, a scan and wallet metrics. Writes nothing.
import { config } from '../src/config'
import { discoverQualityTokens } from '../src/services/birdeye'
import { getTokenQuotes } from '../src/services/dexscreener'
import { scanToken } from '../src/services/token-scanner'
import { getLiveWalletMetrics } from '../src/services/wallet-live-metrics'

async function main() {
  const w = config.worker
  const tokens = await discoverQualityTokens('bsc', {
    minChurn: w.discoveryMinChurn, maxChurn: w.discoveryMaxChurn, minHolders: w.discoveryMinHolders,
    minLiquidity: w.discoveryMinLiquidity, minTrades24h: w.discoveryMinTrades24h, minVolume24h: w.discoveryMinVolume24h,
    minFdv: w.discoveryMinFdv, maxFdv: w.discoveryMaxFdv, maxBuySellRatio: w.discoveryMaxBuySellRatio,
    minAgeHours: w.discoveryMinAgeHours, maxAgeDays: w.discoveryMaxAgeDays, pages: w.discoveryPages,
    launchTimes: async (addresses) => {
      const quotes = await getTokenQuotes('bsc', addresses)
      return new Map([...quotes].filter(([, q]) => q.firstPoolAt).map(([a, q]) => [a, Math.floor(q.firstPoolAt! / 1000)]))
    },
  })
  console.log(`discovery: ${tokens.length} BSC tokens cleared the churn screen`)
  for (const t of tokens.slice(0, 5)) {
    console.log(`  ${t.symbol} churn=${t.churn.toFixed(2)} holders=${t.holders} age=${((Date.now() / 1000 - t.listedAt) / 86400).toFixed(1)}d img=${Boolean(t.imageUrl)}`)
  }
  const target = tokens[0]?.address ?? '0x14f6a94909c407854390aa2d2462a3095d317777'
  const scan = await scanToken('bsc', target)
  console.log('scan:', scan.symbol, 'pools', scan.poolCount, 'liq', Math.round(scan.liquidityUsd ?? 0), 'holders', scan.holders.count)
  console.log('  security', JSON.stringify(scan.security))
  console.log('  verdict', scan.risk.verdict, scan.risk.flags.map((f) => f.title).join('; '))
  console.log('  links', scan.links.map((l) => l.label).join(', '))
  const metrics = await getLiveWalletMetrics('bsc', ['0x8894E0a0c962CB723c1976a4421c95949bE2D4E3'])
  console.log('wallet metrics:', JSON.stringify([...metrics.values()][0]))
  process.exit(0)
}
main().catch((error) => { console.error(error); process.exit(1) })
