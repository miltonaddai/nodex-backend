/**
 * Analyzes one token's launch for the Insider Plays page, then refreshes the page's data.
 * Use it for a token the automatic scan missed, e.g. one older than INSIDER_SCAN_MAX_AGE_DAYS.
 *
 *   npx tsx scripts/analyze-insider-token.ts <mint>
 */
import { getTokenOverview } from '../src/services/birdeye'
import { analyzeInsiderToken, syncInsiderPlays } from '../src/workers/sync-insiders'

async function main() {
  const mint = process.argv[2]
  if (!mint) throw new Error('Usage: npx tsx scripts/analyze-insider-token.ts <mint>')
  const token = await getTokenOverview(mint, 'solana')
  if (!token) throw new Error(`Birdeye has no overview for ${mint}`)
  await analyzeInsiderToken('solana', { ...token, address: mint })
  await syncInsiderPlays('solana')
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
