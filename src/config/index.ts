import dotenv from 'dotenv'
import type { Request } from 'express'
import { readKeys } from '../services/api-key-pool'

dotenv.config()

function parseAllowedOrigins(): string[] {
  const raw = process.env.CORS_ORIGIN || 'http://localhost:5173'
  const origins = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const frontend = process.env.FRONTEND_URL?.trim()
  if (frontend && !origins.includes(frontend)) origins.push(frontend)
  return origins
}

const allowedOrigins = parseAllowedOrigins()

const tokenSyncIntervalMinutes = parseInt(process.env.TOKEN_SYNC_INTERVAL_MINUTES || '120', 10)
// 0 disables the standalone market-health timer; health is still refreshed inside every pipeline
// run. A timer shorter than ClickHouse Cloud's idle timeout keeps the service awake around the
// clock, which is what drove the bill with no traffic.
const dexScreenerRefreshIntervalMinutes = parseInt(process.env.DEXSCREENER_REFRESH_INTERVAL_MINUTES || '0', 10)
// Health rows must outlive the gap between refreshes, or the tokens list empties between runs.
const marketHealthCadenceMinutes =
  dexScreenerRefreshIntervalMinutes > 0 ? dexScreenerRefreshIntervalMinutes : tokenSyncIntervalMinutes

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  allowedOrigins,

  supabase: {
    url: process.env.SUPABASE_URL || '',
    anonKey: process.env.SUPABASE_ANON_KEY || '',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  },

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },

  clickhouse: {
    url: process.env.CLICKHOUSE_URL || 'http://localhost:8123',
    database: process.env.CLICKHOUSE_DATABASE || 'nodex',
    username: process.env.CLICKHOUSE_USER || 'default',
    password: process.env.CLICKHOUSE_PASSWORD || '',
    requestTimeoutMs: parseInt(process.env.CLICKHOUSE_REQUEST_TIMEOUT_MS || '60000', 10),
  },

  helius: {
    // Several keys are allowed (HELIUS_API_KEY, HELIUS_API_KEY_2, …); see services/api-key-pool.
    // apiKey is the first, kept for the "is Helius configured" checks.
    apiKeys: readKeys('HELIUS_API_KEY'),
    apiKey: readKeys('HELIUS_API_KEY')[0] ?? '',
    baseUrl: 'https://api.helius.xyz/v0',
    rpcUrl: 'https://mainnet.helius-rpc.com',
  },

  birdeye: {
    // Several keys are allowed (BIRDEYE_API_KEY, BIRDEYE_API_KEY_2, …); see services/api-key-pool.
    apiKeys: readKeys('BIRDEYE_API_KEY'),
    apiKey: readKeys('BIRDEYE_API_KEY')[0] ?? '',
    // Gap between Birdeye calls. The Lite plan allows 15 requests per second, so 100ms (10 per
    // second) leaves headroom. The free plan needs about 1000.
    minIntervalMs: parseInt(process.env.BIRDEYE_MIN_INTERVAL_MS || '100', 10),
    baseUrl: 'https://public-api.birdeye.so',
  },

  fomo: {
    // fomoapi.io, source of the tracked trader list (refreshed monthly by scripts/refresh-fomo-traders.ts).
    apiKey: process.env.FOMO_API_KEY || '',
  },

  blockscout: {
    // Keyed Blockscout gateway, used for Robinhood Chain holder counts.
    apiKey: process.env.BLOCKSCOUT_API_KEY || '',
  },

  alchemy: {
    apiKey: process.env.ALCHEMY_API_KEY || '',
    solanaUrl: process.env.ALCHEMY_SOLANA_URL || '',
    robinhoodUrl: process.env.ALCHEMY_ROBINHOOD_URL || '',
  },

  bsc: {
    // JSON-RPC for BNB balances. BNB Chain's public endpoint needs no key and accepts batches.
    rpcUrl: process.env.BSC_RPC_URL || 'https://bsc-dataseed.bnbchain.org',
  },

  /**
   * Master switch for the subscription/paywall layer.
   *
   * Off, every authenticated user gets full access and the subscription checks are bypassed.
   * Keep it in step with VITE_SUBSCRIPTIONS_ENABLED on the frontend.
   */
  subscriptionsEnabled: process.env.SUBSCRIPTIONS_ENABLED === 'true',

  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    priceStarter: process.env.STRIPE_PRICE_STARTER || '',
    pricePro: process.env.STRIPE_PRICE_PRO || '',
  },

  frontendUrl: process.env.FRONTEND_URL?.trim() || allowedOrigins[0] || 'http://localhost:5173',

  worker: {
    enabled: process.env.WORKER_ENABLED !== 'false',
    tokenSyncIntervalMinutes,
    pipelineTimeoutMinutes: parseInt(process.env.WORKER_PIPELINE_TIMEOUT_MINUTES || '110', 10),
    providerRequestTimeoutMs: parseInt(process.env.PROVIDER_REQUEST_TIMEOUT_MS || '30000', 10),
    walletSyncIntervalMinutes: parseInt(process.env.WALLET_SYNC_INTERVAL_MINUTES || '60', 10),
    syncChains: (process.env.SYNC_CHAINS || 'solana,robinhood,bsc').split(',').map((c) => c.trim()).filter(Boolean),
    tokenFetchLimit: parseInt(process.env.TOKEN_FETCH_LIMIT || '200', 10),
    tokenMinLiquidity: parseInt(process.env.TOKEN_MIN_LIQUIDITY || '10000', 10),
    tokenMinVolume: parseInt(process.env.TOKEN_MIN_VOLUME || '5000', 10),
    tokenMinMarketCap: parseInt(process.env.TOKEN_MIN_MARKET_CAP || '10000', 10),
    tokenMinHolders: parseInt(process.env.TOKEN_MIN_HOLDERS || '20', 10),
    alphaMaxTokenAgeDays: parseInt(process.env.ALPHA_MAX_TOKEN_AGE_DAYS || '30', 10),
    alphaMaxMarketCap: parseInt(process.env.ALPHA_MAX_MARKET_CAP || '20000000', 10),
    alphaTokenPageSize: parseInt(process.env.ALPHA_TOKEN_PAGE_SIZE || '50', 10),
    // Raw transactions per trade-ingestion request (max 1000). Helius bills raw history at 10
    // credits per 100 transactions, so the page size sets latency, not cost.
    alphaTransactionPageSize: parseInt(process.env.ALPHA_TRANSACTION_PAGE_SIZE || '500', 10),
    // Page cap per token per visit. Ingestion resumes where it stopped, so the cap bounds the
    // credits one visit can spend (15 x 500 transactions = 750 credits) without losing trades.
    alphaBackfillPagesPerToken: parseInt(process.env.ALPHA_BACKFILL_PAGES_PER_TOKEN || '15', 10),
    alphaTokensPerRun: parseInt(process.env.ALPHA_TOKENS_PER_RUN || '40', 10),
    // Minimum launch age before a token is worth evaluating. Hours-old launches are dominated by
    // bundles, and retention/independence cannot be measured before holders have had time to act
    // — scoring them was surfacing nothing but launch-day noise.
    alphaMinTokenAgeDays: parseInt(process.env.ALPHA_MIN_TOKEN_AGE_DAYS || '3', 10),
    alphaMinDistinctTokens: parseInt(process.env.ALPHA_MIN_DISTINCT_TOKENS || '1', 10),
    alphaMinSmartScore: parseFloat(process.env.ALPHA_MIN_SMART_SCORE || '50'),
    alphaMinPeriodProfitUsd: parseFloat(process.env.ALPHA_MIN_PERIOD_PROFIT_USD || '100'),
    alphaMinPeriodTrades: parseInt(process.env.ALPHA_MIN_PERIOD_TRADES || '5', 10),
    alphaTopTraderTokens: parseInt(process.env.ALPHA_TOP_TRADER_TOKENS || '10', 10),
    alphaTopTraderTokens30d: parseInt(process.env.ALPHA_TOP_TRADER_TOKENS_30D || '30', 10),
    alphaTopTradersPerToken: parseInt(process.env.ALPHA_TOP_TRADERS_PER_TOKEN || '10', 10),
    alphaTopTraders24hRefreshHours: parseInt(process.env.ALPHA_TOP_TRADERS_24H_REFRESH_HOURS || '24', 10),
    alphaTopTraders7dRefreshHours: parseInt(process.env.ALPHA_TOP_TRADERS_7D_REFRESH_HOURS || '72', 10),
    alphaTopTraders30dRefreshHours: parseInt(process.env.ALPHA_TOP_TRADERS_30D_REFRESH_HOURS || '168', 10),
    dexScreenerRefreshIntervalMinutes,
    tokenMarketHealthMaxAgeMinutes: parseInt(
      process.env.TOKEN_MARKET_HEALTH_MAX_AGE_MINUTES || String(marketHealthCadenceMinutes * 2),
      10
    ),
    alphaMinQualifiedBuyers: parseInt(process.env.ALPHA_MIN_QUALIFIED_BUYERS || '2', 10),
    // Alpha v2 — evidence tiering, real-buyer detection and out-of-sample reputation.
    alphaMinTradesForEvidence: parseInt(process.env.ALPHA_MIN_TRADES_FOR_EVIDENCE || '25', 10),
    alphaMinTradersForEvidence: parseInt(process.env.ALPHA_MIN_TRADERS_FOR_EVIDENCE || '10', 10),
    // 0 = count any net-accumulating wallet. Genuine retail buys on new launches are typically
    // under $10, so a dollar floor here silently destroys the buyer-count signal.
    alphaMinBuyerPositionUsd: parseFloat(process.env.ALPHA_MIN_BUYER_POSITION_USD || '0'),
    // Floor on buyer breadth. Set at 50 rather than 100 because raw counts turned out to be the
    // weaker signal: the only mature token clearing 100 was a wallet farm (287 buyers, 4%
    // independent, $226k cap) while the strongest candidate sat at 70. Independence and holder
    // wealth do the discriminating; this just excludes the obviously thin.
    alphaMinRealBuyers: parseInt(process.env.ALPHA_MIN_REAL_BUYERS || '50', 10),
    // Holder-wealth signal (Helius-enriched; independent of the Birdeye quota).
    alphaWealthyHolderMinUsd: parseFloat(process.env.ALPHA_WEALTHY_HOLDER_MIN_USD || '10000'),
    alphaTopHoldersToEnrich: parseInt(process.env.ALPHA_TOP_HOLDERS_TO_ENRICH || '10', 10),
    // Buyer count at which a token becomes worth enriching. Kept below alphaMinRealBuyers so
    // tokens near the scoring threshold still get wealth data instead of failing for lack of it.
    alphaEnrichMinBuyers: parseInt(process.env.ALPHA_ENRICH_MIN_BUYERS || '20', 10),
    alphaWealthTtlHours: parseInt(process.env.ALPHA_WEALTH_TTL_HOURS || '24', 10),
    // Of the top holders sampled, how many must clear the wealth bar. Throwaway wallets holding
    // the largest positions is the shape of a bundle.
    alphaMinWealthyHolders: parseInt(process.env.ALPHA_MIN_WEALTHY_HOLDERS || '3', 10),
    alphaMinClosedPositions: parseInt(process.env.ALPHA_MIN_CLOSED_POSITIONS || '2', 10),
    // How many OTHER ingested tokens a wallet must have traded to count as independent.
    // Bounded by ingestion coverage: with ~50 contracts ingested, requiring 2 is unmeasurable,
    // so it defaults to 1. Raise this as ALPHA_TOKENS_PER_RUN grows the ingested universe.
    alphaMinOtherTokens: parseInt(process.env.ALPHA_MIN_OTHER_TOKENS || '1', 10),
    // Share of real buyers that must have traded other tokens. Wallet farms score ~0 here while
    // organically traded tokens sit at 95-100%, and because it is a ratio it holds up regardless
    // of how deeply we sample a token's trades.
    alphaMinIndependentShare: parseFloat(process.env.ALPHA_MIN_INDEPENDENT_SHARE || '0.5'),
    // Ceiling on market cap carried per real buyer. A genuine holder base spreads valuation
    // across many buyers. Observed p50 is ~$3.5k and p75 ~$14.7k, while the TNOS bundle sat at
    // $74.6k — so this is the metric that separates "priced" from "held".
    alphaMaxMcapPerBuyer: parseFloat(process.env.ALPHA_MAX_MCAP_PER_BUYER || '25000'),

    // --- Discovery v2: churn-based quality screen ---
    // churn = unique_wallet_24h / holder, both from the Birdeye discovery call.
    // Bot farms mint one wallet per holder and trade each once, pinning churn at ~1.00 (54 of
    // 122 sampled tokens sat in 0.5-1.2). Seeded bundles never trade, sitting near 0. Organic
    // tokens have traders who exit and holders who sit still, breaking the identity upward.
    // Verified-legitimate examples measured 1.94 and 2.30; the 1.2-1.5 band was empty across
    // the sample, so the distribution is genuinely bimodal rather than a tuned cutoff.
    discoveryMinChurn: parseFloat(process.env.DISCOVERY_MIN_CHURN || '1.5'),
    // Loose upper guard only. Four independently hand-verified legitimate tokens span 1.94 to
    // 12.13 (JORDAN 2.30, Kimchi 1.94, CATJAK 5.21, :p 12.13), so high churn is not itself a
    // negative signal — an earlier cap of 8 would have wrongly excluded a confirmed-good token.
    // This exists purely to catch pathological values, not to bound normal behaviour.
    discoveryMaxChurn: parseFloat(process.env.DISCOVERY_MAX_CHURN || '50'),
    // Below this holder count the ratio is too noisy to trust.
    discoveryMinHolders: parseInt(process.env.DISCOVERY_MIN_HOLDERS || '150', 10),
    discoveryMinLiquidity: parseFloat(process.env.DISCOVERY_MIN_LIQUIDITY || '15000'),
    discoveryMinTrades24h: parseInt(process.env.DISCOVERY_MIN_TRADES_24H || '200', 10),
    discoveryMinVolume24h: parseFloat(process.env.DISCOVERY_MIN_VOLUME_24H || '25000'),
    discoveryMinFdv: parseFloat(process.env.DISCOVERY_MIN_FDV || '50000'),
    discoveryMaxFdv: parseFloat(process.env.DISCOVERY_MAX_FDV || '10000000'),
    // Pump-only bundles buy far more often than they sell.
    discoveryMaxBuySellRatio: parseFloat(process.env.DISCOVERY_MAX_BUY_SELL_RATIO || '2'),
    discoveryMinAgeHours: parseInt(process.env.DISCOVERY_MIN_AGE_HOURS || '1', 10),
    discoveryMaxAgeDays: parseInt(process.env.DISCOVERY_MAX_AGE_DAYS || '14', 10),
    discoveryPages: parseInt(process.env.DISCOVERY_PAGES || '4', 10),

    // --- Insider plays: launch-bundle detection, independent of the churn screen ---
    // The churn screen rejects exactly these tokens (bundled launches sit in the 0.5-1.2 farm
    // band), so insider detection runs on its own candidate list of fresh listings.
    insiderScanMaxAgeDays: parseInt(process.env.INSIDER_SCAN_MAX_AGE_DAYS || '3', 10),
    // Wait until the launch window has fully settled before analyzing it.
    insiderScanMinAgeMinutes: parseInt(process.env.INSIDER_SCAN_MIN_AGE_MINUTES || '30', 10),
    insiderScanMinLiquidity: parseFloat(process.env.INSIDER_SCAN_MIN_LIQUIDITY || '20000'),
    insiderScanMinVolume24h: parseFloat(process.env.INSIDER_SCAN_MIN_VOLUME_24H || '50000'),
    insiderScanMinHolders: parseInt(process.env.INSIDER_SCAN_MIN_HOLDERS || '200', 10),
    insiderScanCandidates: parseInt(process.env.INSIDER_SCAN_CANDIDATES || '50', 10),
    // Launch analysis costs roughly 60-80 Helius calls per token, so new tokens are capped per run.
    insiderMaxNewPerRun: parseInt(process.env.INSIDER_MAX_NEW_PER_RUN || '5', 10),
    // Seconds after the first transaction that count as the launch.
    insiderLaunchWindowSeconds: parseInt(process.env.INSIDER_LAUNCH_WINDOW_SECONDS || '120', 10),
    insiderMaxLaunchTxs: parseInt(process.env.INSIDER_MAX_LAUNCH_TXS || '500', 10),
    // Launch buyers whose funding source is traced. Each costs two Helius calls.
    insiderFunderLookups: parseInt(process.env.INSIDER_FUNDER_LOOKUPS || '30', 10),
    // How long an analyzed token keeps being refreshed on the insider page.
    insiderTrackDays: parseInt(process.env.INSIDER_TRACK_DAYS || '14', 10),
    insiderMaxTracked: parseInt(process.env.INSIDER_MAX_TRACKED || '40', 10),
    // Below this liquidity a token's pool has been pulled or drained: most insider launches with
    // $0 liquidity also had no trades in the last hour. They are not tradeable, so they are hidden
    // and no longer refreshed.
    insiderMinLiquidity: parseFloat(process.env.INSIDER_MIN_LIQUIDITY || '5000'),

    // --- Smart money: what the top FOMO traders are buying ---
    // The tracked wallets come from src/data/fomo-top-traders.json (npm run fomo:refresh, monthly).
    smartMoneyBuyWindowHours: parseInt(process.env.SMART_MONEY_BUY_WINDOW_HOURS || '72', 10),
    // Caps the backfill for very active wallets (100 swaps per page).
    smartMoneyMaxSwapPages: parseInt(process.env.SMART_MONEY_MAX_SWAP_PAGES || '20', 10),
    // A wallet counts as buying a token only when it is a net buyer of at least this much.
    smartMoneyMinNetBuyUsd: parseFloat(process.env.SMART_MONEY_MIN_NET_BUY_USD || '250'),
    // Tokens below this liquidity are dropped: they are dead launches or a wallet buying into
    // its own fresh deployments (one top wallet "bought" five $2k-cap tokens for $17k each).
    smartMoneyMinLiquidity: parseFloat(process.env.SMART_MONEY_MIN_LIQUIDITY || '10000'),
    alphaFreshWalletDays: parseInt(process.env.ALPHA_FRESH_WALLET_DAYS || '7', 10),
    alphaMaxFreshBuyerShare: parseFloat(process.env.ALPHA_MAX_FRESH_BUYER_SHARE || '0.5'),
    alphaMinWalletNetWorthUsd: parseFloat(process.env.ALPHA_MIN_WALLET_NET_WORTH_USD || '1000'),
    walletBirdeyeCandidates: parseInt(process.env.WALLET_BIRDEYE_CANDIDATES || '50', 10),
    walletPnlEnrichLimit: parseInt(process.env.WALLET_PNL_ENRICH_LIMIT || '12', 10),
    walletHeliusEnrichLimit: parseInt(process.env.WALLET_HELIUS_ENRICH_LIMIT || '25', 10),
    // Distinct churn-qualified tokens a wallet must have traded profitably to be listed.
    // One winner is luck; the page is for wallets that repeat across tokens we trust.
    walletMinQualifiedTokens: parseInt(process.env.WALLET_MIN_QUALIFIED_TOKENS || '2', 10),
    walletMinTrades: parseInt(process.env.WALLET_MIN_TRADES || '5', 10),
    walletMinVolumeUsd: parseInt(process.env.WALLET_MIN_VOLUME_USD || '1000', 10),
    walletMinBalanceUsd: parseInt(process.env.WALLET_MIN_BALANCE_USD || '500', 10),
    walletMinWinRate: parseInt(process.env.WALLET_MIN_WIN_RATE || '40', 10),
    walletMaxProfitToVolumeRatio: parseFloat(process.env.WALLET_MAX_PROFIT_VOLUME_RATIO || '5'),
    walletSeedAddresses: (process.env.WALLET_SEED_ADDRESSES || '')
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean),
    solUsdPriceFallback: parseFloat(process.env.SOL_USD_PRICE_FALLBACK || '150'),
  },
}

/** Use the request Origin when allowed so Stripe redirects back to the correct dev port. */
export function resolveFrontendUrl(req: Pick<Request, 'headers'>): string {
  const origin = req.headers.origin
  if (origin && allowedOrigins.includes(origin)) return origin
  return config.frontendUrl
}
