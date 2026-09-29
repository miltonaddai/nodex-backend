/**
 * Refreshes the smart money trader list from FOMO's leaderboards. Run once a month, then commit
 * src/data/fomo-top-traders.json and redeploy.
 *
 *   npm run fomo:refresh
 *
 * FOMO serves at most 150 traders per window (100 for all-time) with no paging, so the list is
 * built by window: the whole 30-day board first, then traders only on the 7-day, all-time and
 * 24-hour boards. Costs four leaderboard reads (1,000 credits).
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { getFomoLeaderboard, type FomoLeaderboardTrader, type LeaderboardWindow } from '../src/services/fomo'
import type { FomoTrader, FomoTraderFile } from '../src/lib/fomo-traders'

const LIST_SIZE = 250
const WINDOWS: LeaderboardWindow[] = ['30d', '7d', 'all', '24h']
const OUT = path.join(__dirname, '..', 'src', 'data', 'fomo-top-traders.json')

async function main() {
  const boards = new Map<LeaderboardWindow, FomoLeaderboardTrader[]>()
  for (const window of WINDOWS) boards.set(window, await getFomoLeaderboard(window))

  const pnlIn = (window: LeaderboardWindow, userId: string) =>
    boards.get(window)?.find((t) => t.userId === userId)?.pnlUsd ?? null

  const picked = new Map<string, FomoLeaderboardTrader>()
  for (const window of WINDOWS) {
    const board = [...(boards.get(window) ?? [])].sort((a, b) => b.pnlUsd - a.pnlUsd)
    for (const trader of board) {
      if (picked.size >= LIST_SIZE) break
      const hasWallet = Boolean(trader.wallets?.solana || trader.wallets?.evm)
      if (hasWallet && !picked.has(trader.userId)) picked.set(trader.userId, trader)
    }
  }

  const traders: FomoTrader[] = [...picked.values()].map((t, index) => ({
    rank: index + 1,
    userId: t.userId,
    handle: t.handle,
    displayName: t.displayName,
    avatar: t.avatar ?? '',
    pnl30dUsd: pnlIn('30d', t.userId),
    pnl7dUsd: pnlIn('7d', t.userId),
    pnlAllUsd: pnlIn('all', t.userId),
    volumeUsd: t.volumeUsd,
    trades: t.trades,
    followers: t.followers,
    wallets: { solana: t.wallets?.solana || null, evm: t.wallets?.evm || null },
  }))

  const file: FomoTraderFile = {
    generatedAt: new Date().toISOString(),
    source: `fomoapi.io /v2/leaderboard (${WINDOWS.join(', ')})`,
    traders,
  }
  writeFileSync(OUT, `${JSON.stringify(file, null, 2)}\n`)
  const counts = WINDOWS.map((w) => `${w}: ${boards.get(w)?.length ?? 0}`).join(', ')
  console.log(
    `Saved ${traders.length} traders to ${path.relative(process.cwd(), OUT)} ` +
      `(${traders.filter((t) => t.wallets.solana).length} Solana, ${traders.filter((t) => t.wallets.evm).length} EVM wallets; boards ${counts})`
  )
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
