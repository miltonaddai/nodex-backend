import { config } from '../config'
import { insertClickhouse, queryClickhouse } from '../services/clickhouse'
import { enrichSolanaWalletBalanceUsd, getSolanaWalletTokenCount } from '../services/helius'

interface TopHolderRow {
  wallet_address: string
}

function formatNow(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

/**
 * Enriches the largest holders of credible tokens with real wallet balances.
 *
 * Birdeye returns net worth as 0 on the free plan, so wealth comes from Helius instead. Results
 * are cached in wallet_wealth with a TTL and only the top holders of tokens that already clear
 * the real-buyer bar are fetched, which keeps this to a bounded number of calls per run.
 * Helius has its own quota — this does not touch the Birdeye budget.
 */
export async function syncHolderWealth(chain: string): Promise<void> {
  if (chain !== 'solana' || !config.helius.apiKey) {
    console.warn('[holder-wealth] Requires a Solana Helius key; skipping')
    return
  }

  // Top holders of tokens that already look credible on buyer breadth. Wallets already enriched
  // inside the TTL are skipped so repeat runs cost almost nothing.
  const wallets = await queryClickhouse<TopHolderRow>(
    `WITH positions AS (
       SELECT
         contract,
         wallet_address,
         sumIf(quote_usd, side = 'buy') - sumIf(quote_usd, side = 'sell') AS net_usd,
         minIf(minutes_after_launch, side = 'buy') AS entry_minutes
       FROM wallet_token_trades
       WHERE chain = {chain:String}
       GROUP BY contract, wallet_address
     ),
     credible AS (
       SELECT contract
       FROM positions
       WHERE net_usd > 0 AND entry_minutes > {sniperWindow:UInt16}
       GROUP BY contract
       -- Deliberately looser than the scoring gate: if enrichment only covered tokens that
       -- already pass the buyer threshold, tokens below it could never obtain wealth data and
       -- would then fail the wealth gate for lack of it.
       HAVING count() >= {minEnrichBuyers:UInt32}
     ),
     ranked AS (
       SELECT
         p.wallet_address AS wallet_address,
         row_number() OVER (PARTITION BY p.contract ORDER BY p.net_usd DESC) AS rank
       FROM positions AS p
       INNER JOIN credible AS c ON c.contract = p.contract
       WHERE p.net_usd > 0 AND p.entry_minutes > {sniperWindow:UInt16}
     )
     SELECT DISTINCT wallet_address
     FROM ranked
     WHERE rank <= {topHolders:UInt16}
       AND wallet_address NOT IN (
         SELECT wallet_address FROM wallet_wealth FINAL
         WHERE chain = {chain:String}
           AND checked_at >= now() - toIntervalHour({ttlHours:UInt16})
       )`,
    {
      chain,
      sniperWindow: 5,
      minEnrichBuyers: config.worker.alphaEnrichMinBuyers,
      topHolders: config.worker.alphaTopHoldersToEnrich,
      ttlHours: config.worker.alphaWealthTtlHours,
    }
  )

  if (wallets.length === 0) {
    console.log('[holder-wealth] No holders need enrichment')
    return
  }

  console.log(`[holder-wealth] Enriching ${wallets.length} top holders via Helius`)
  const rows: Record<string, unknown>[] = []
  const checkedAt = formatNow()

  for (const { wallet_address: wallet } of wallets) {
    try {
      const netWorthUsd = await enrichSolanaWalletBalanceUsd(
        wallet,
        config.worker.solUsdPriceFallback
      )
      const tokensHeld = (await getSolanaWalletTokenCount(wallet)) ?? 0
      rows.push({
        wallet_address: wallet,
        chain,
        net_worth_usd: netWorthUsd,
        tokens_held: tokensHeld,
        checked_at: checkedAt,
      })
    } catch (error) {
      console.warn(`[holder-wealth] Failed to enrich ${wallet}:`, error)
    }
  }

  if (rows.length > 0) {
    await insertClickhouse('wallet_wealth', rows)
    const wealthy = rows.filter(
      (row) => Number(row.net_worth_usd) >= config.worker.alphaWealthyHolderMinUsd
    ).length
    console.log(`[holder-wealth] Stored ${rows.length} balances (${wealthy} above wealth threshold)`)
  }
}

export async function syncAllHolderWealth(): Promise<void> {
  for (const chain of config.worker.syncChains) await syncHolderWealth(chain)
}
