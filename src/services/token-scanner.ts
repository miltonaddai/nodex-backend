import { fomoTraderList, walletForChain } from '../lib/fomo-traders'
import { insiderStatus, type LaunchInsiderReport } from '../lib/insider-detection'
import { assessRisk, type RiskReport, type ScanFacts } from '../lib/token-risk'
import { getEvmNativeBalances } from './alchemy'
import { getEvmTokenSecurity, getTokenStats, getWalletNetWorthUsd, type EvmTokenSecurity } from './birdeye'
import { getEvmTokenHolders, isContractVerified } from './blockscout'
import { queryClickhouse } from './clickhouse'
import { getTokenPairs, type DexPair } from './dexscreener'
import { getLargestHolders, getMintSecurity, getOwnerTokenBalance, type MintSecurity } from './helius'
import { analyzeLaunch } from '../workers/sync-insiders'

/**
 * Token scanner: everything WhaleMo knows about one token, and a buy-or-avoid verdict.
 *
 * The main scan is fast (market, security, holders, smart money). The launch bundle analysis
 * reads the token's first transactions and funders, costs 40-60 Helius calls and takes up to a
 * minute, so it is a separate call. Solana only: its strongest signal, several wallets signing
 * one buy, has no equivalent on EVM chains.
 *
 * BNB Chain has no holder list (Blockscout does not cover it and Birdeye's holder endpoint does
 * not support it), so its scan reads Birdeye's contract audit instead: holder count, mint, tax
 * and honeypot checks.
 */

export type ScanChain = 'solana' | 'robinhood' | 'bsc'

export interface ScanHolder {
  rank: number
  address: string
  amount: number
  pctOfSupply: number
  valueUsd: number
  /** SOL or ETH in the wallet. */
  nativeBalance: number | null
  /** Whole-portfolio value, where the chain supports it. */
  netWorthUsd: number | null
  isPool: boolean
  label: string | null
  fomoHandle: string | null
  isInsider: boolean
}

export interface ScanBundle {
  launchBuyers: number
  insiderWallets: string[]
  insiderAcquiredPct: number
  insiderHoldingPct: number | null
  insiderStatus: string
  linkedWallets: number
  clusters: Array<{ wallets: string[]; boughtPct: number; linkKinds: string[] }>
  creationBlockSupplyPct: number
  launchScore: number
  evidence: string[]
  launchedAt: string
}

export interface ScanResult {
  chain: ScanChain
  address: string
  name: string
  symbol: string
  imageUrl: string
  priceUsd: number | null
  marketCapUsd: number | null
  liquidityUsd: number | null
  volume24hUsd: number | null
  priceChange24h: number | null
  ageHours: number | null
  poolCount: number
  primaryDex: string | null
  links: Array<{ label: string; url: string }>
  security: {
    mintAuthority: string | null
    freezeAuthority: string | null
    transferFeeBps: number | null
    transferFeeAuthority: string | null
    permanentDelegate: string | null
    contractVerified: boolean | null
    /** EVM contract audit (BNB Chain): the token cannot be sold. Null where not checked. */
    honeypot: boolean | null
  }
  holders: {
    count: number | null
    top10Pct: number | null
    largestHolderPct: number | null
    list: ScanHolder[]
  }
  trading: {
    buys24h: number | null
    sells24h: number | null
    uniqueWallets24h: number | null
    churn: number | null
  }
  smartMoney: Array<{ handle: string; displayName: string; netBuyUsd: number }>
  bundle: ScanBundle | null
  bundleAvailable: boolean
  risk: RiskReport
  scannedAt: string
}

/**
 * Pool authorities are ordinary system accounts, so they look like wallets to an ownership check.
 * Raydium CPMM's authority showed up as a "$179M wallet" on Super Inu.
 */
const KNOWN_POOL_AUTHORITIES: Record<string, string> = {
  GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL: 'Raydium CPMM pool',
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1': 'Raydium AMM pool',
  WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh: 'Raydium LaunchLab curve',
}

/** Wallet balances are looked up for this many of the largest non-pool holders. */
const BALANCE_LOOKUPS = 10
/** Funder lookups for an interactive bundle scan. The worker uses more. */
const SCAN_FUNDER_LOOKUPS = 15

function num(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function fomoHandles(chain: ScanChain): Map<string, { handle: string; displayName: string }> {
  const map = new Map<string, { handle: string; displayName: string }>()
  for (const trader of fomoTraderList().traders) {
    const wallet = walletForChain(trader, chain)
    if (wallet) map.set(wallet.toLowerCase(), { handle: trader.handle, displayName: trader.displayName })
  }
  return map
}

function linksFor(chain: ScanChain, address: string, pair: DexPair | undefined, socials: Record<string, string>) {
  const links: Array<{ label: string; url: string }> = []
  if (pair?.url) links.push({ label: 'Dexscreener', url: pair.url })
  links.push(
    chain === 'solana'
      ? { label: 'Solscan', url: `https://solscan.io/token/${address}` }
      : chain === 'bsc'
        ? { label: 'BscScan', url: `https://bscscan.com/token/${address}` }
        : { label: 'Blockscout', url: `https://robinhoodchain.blockscout.com/token/${address}` }
  )
  const seen = new Set(links.map((l) => l.url))
  const push = (label: string, url?: string) => {
    if (url && !seen.has(url)) {
      seen.add(url)
      links.push({ label, url })
    }
  }
  for (const site of pair?.info?.websites ?? []) push('Website', site.url)
  for (const social of pair?.info?.socials ?? []) push(social.type ? social.type[0].toUpperCase() + social.type.slice(1) : 'Social', social.url)
  for (const [key, url] of Object.entries(socials)) push(key[0].toUpperCase() + key.slice(1), url)
  return links
}

async function smartMoneyBuyers(chain: ScanChain, address: string) {
  const [row] = await queryClickhouse<{ wallets: string[]; wallet_net_buy_usd: number[] }>(
    `SELECT wallets, wallet_net_buy_usd FROM smart_money_buys
     WHERE chain = {chain:String} AND lower(contract) = lower({address:String})
       AND snapshot_at = (SELECT max(snapshot_at) FROM smart_money_buys WHERE chain = {chain:String})
     LIMIT 1`,
    { chain, address }
  ).catch(() => [])
  if (!row) return []
  const handles = fomoHandles(chain)
  return row.wallets
    .map((wallet, i) => ({ wallet, netBuyUsd: Number(row.wallet_net_buy_usd[i] ?? 0), trader: handles.get(wallet.toLowerCase()) }))
    .filter((entry) => entry.trader)
    .map((entry) => ({ handle: entry.trader!.handle, displayName: entry.trader!.displayName, netBuyUsd: entry.netBuyUsd }))
}

/** A launch analysis the insider worker already stored, if it covered this token. */
async function storedBundle(address: string): Promise<ScanBundle | null> {
  const [row] = await queryClickhouse<{
    launch_buyers: number
    insider_wallets: string[]
    insider_acquired_pct: number
    insider_holding_pct: number
    insider_status: string
    linked_wallets: number
    creation_block_supply_pct: number
    launch_score: number
    evidence: string[]
    launched_at: string
    updated_at: string
    analyzed_at: string
  }>(
    `SELECT * FROM token_insider_analysis FINAL WHERE chain = 'solana' AND contract = {address:String} LIMIT 1`,
    { address }
  ).catch(() => [])
  if (!row) return null
  const refreshed = row.updated_at > row.analyzed_at
  return {
    launchBuyers: Number(row.launch_buyers),
    insiderWallets: row.insider_wallets,
    insiderAcquiredPct: Number(row.insider_acquired_pct),
    insiderHoldingPct: refreshed ? Number(row.insider_holding_pct) : null,
    insiderStatus: refreshed ? row.insider_status : 'unknown',
    linkedWallets: Number(row.linked_wallets),
    clusters: [],
    creationBlockSupplyPct: Number(row.creation_block_supply_pct),
    launchScore: Number(row.launch_score),
    evidence: row.evidence,
    launchedAt: `${row.launched_at.replace(' ', 'T')}Z`,
  }
}

function factsFor(result: Omit<ScanResult, 'risk'>): ScanFacts {
  // Solana reads the mint account; BNB Chain reads Birdeye's contract audit. Robinhood Chain has neither.
  const checked = result.chain === 'solana' || result.chain === 'bsc'
  const solana = result.chain === 'solana'
  const { security } = result
  return {
    liquidityUsd: result.liquidityUsd,
    marketCapUsd: result.marketCapUsd,
    ageHours: result.ageHours,
    // Mint settings are only read on Solana. On EVM chains they stay unknown.
    mintAuthorityActive: checked ? Boolean(security.mintAuthority) : null,
    freezeAuthorityActive: solana ? Boolean(security.freezeAuthority) : null,
    transferFeeBps: security.transferFeeBps,
    transferFeeChangeable: checked ? Boolean(security.transferFeeAuthority) : null,
    honeypot: security.honeypot,
    permanentDelegate: solana ? Boolean(security.permanentDelegate) : null,
    contractVerified: result.security.contractVerified,
    holders: result.holders.count,
    uniqueWallets24h: result.trading.uniqueWallets24h,
    buys24h: result.trading.buys24h,
    sells24h: result.trading.sells24h,
    top10Pct: result.holders.top10Pct,
    largestHolderPct: result.holders.largestHolderPct,
    bundle: result.bundle
      ? {
          insiderAcquiredPct: result.bundle.insiderAcquiredPct,
          insiderHoldingPct: result.bundle.insiderHoldingPct,
          linkedWallets: result.bundle.linkedWallets,
        }
      : null,
    smartMoneyBuyers: result.smartMoney.length,
  }
}

export async function scanToken(chain: ScanChain, address: string): Promise<ScanResult> {
  const [pairs, stats, smartMoney, bundle] = await Promise.all([
    getTokenPairs(chain, address).catch(() => [] as DexPair[]),
    getTokenStats(address, chain).catch(() => null),
    smartMoneyBuyers(chain, address),
    chain === 'solana' ? storedBundle(address) : Promise.resolve(null),
  ])
  const primary = pairs[0]
  const priceUsd = num(primary?.priceUsd)
  const liquidityUsd = pairs.reduce((sum, pair) => sum + (num(pair.liquidity?.usd) ?? 0), 0)
  const created = pairs.map((pair) => Number(pair.pairCreatedAt)).filter((t) => t > 0)
  const handles = fomoHandles(chain)
  const insiderSet = new Set((bundle?.insiderWallets ?? []).map((w) => w.toLowerCase()))

  let security: MintSecurity | null = null
  let evmAudit: EvmTokenSecurity | null = null
  let contractVerified: boolean | null = null
  let supply = 0
  let holderCount: number | null = stats?.holders ?? null
  let rawHolders: Array<{ address: string; amount: number; isPool: boolean; label: string | null; nativeBalance: number | null }> = []

  if (chain === 'solana') {
    const [mint, holders] = await Promise.all([getMintSecurity(address).catch(() => null), getLargestHolders(address).catch(() => [])])
    security = mint
    supply = mint?.supply ?? 0
    rawHolders = holders.map((h) => {
      const known = KNOWN_POOL_AUTHORITIES[h.owner]
      const isPool = h.isProgramOwned || Boolean(known)
      return {
        address: h.owner,
        amount: h.amount,
        isPool,
        label: known ?? (h.isProgramOwned ? 'Pool or program' : null),
        nativeBalance: isPool ? null : h.solBalance,
      }
    })
  } else if (chain === 'bsc') {
    evmAudit = await getEvmTokenSecurity(address, chain).catch(() => null)
    contractVerified = evmAudit?.openSource ?? null
    // The overview's count is the one discovery's churn screen uses; the audit's runs lower.
    holderCount = holderCount ?? evmAudit?.holderCount ?? null
  } else {
    const [evm, verified] = await Promise.all([getEvmTokenHolders(chain, address), isContractVerified(chain, address).catch(() => null)])
    contractVerified = verified
    supply = evm.supply
    holderCount = evm.holderCount ?? holderCount
    rawHolders = evm.holders.slice(0, 20).map((h) => ({
      address: h.address,
      amount: h.amount,
      isPool: h.isContract,
      label: h.isContract ? h.name || 'Contract' : h.name,
      nativeBalance: null,
    }))
  }

  // Balances for the largest real wallets: portfolio value on Solana, the native coin on EVM chains.
  const wallets = rawHolders.filter((h) => !h.isPool).slice(0, BALANCE_LOOKUPS)
  const netWorth = new Map<string, number | null>()
  if (chain === 'solana') {
    for (const holder of wallets) {
      netWorth.set(holder.address, await getWalletNetWorthUsd(holder.address).catch(() => null))
    }
  } else {
    const balances = await getEvmNativeBalances(chain, wallets.map((h) => h.address)).catch(() => new Map<string, number>())
    for (const holder of wallets) holder.nativeBalance = balances.get(holder.address) ?? null
  }

  const list: ScanHolder[] = rawHolders.map((h, i) => ({
    rank: i + 1,
    address: h.address,
    amount: h.amount,
    pctOfSupply: supply > 0 ? (h.amount / supply) * 100 : 0,
    valueUsd: priceUsd ? h.amount * priceUsd : 0,
    nativeBalance: h.nativeBalance,
    netWorthUsd: netWorth.get(h.address) ?? null,
    isPool: h.isPool,
    label: h.label,
    fomoHandle: handles.get(h.address.toLowerCase())?.handle ?? null,
    isInsider: insiderSet.has(h.address.toLowerCase()),
  }))
  const realHolders = list.filter((h) => !h.isPool)
  const top10Pct = supply > 0 ? realHolders.slice(0, 10).reduce((sum, h) => sum + h.pctOfSupply, 0) : null
  const uniqueWallets24h = stats?.uniqueWallets24h ?? null

  const base: Omit<ScanResult, 'risk'> = {
    chain,
    address,
    name: primary?.baseToken?.name || stats?.name || '',
    symbol: primary?.baseToken?.symbol || stats?.symbol || '',
    imageUrl: primary?.info?.imageUrl || stats?.logoUrl || '',
    priceUsd,
    marketCapUsd: num(primary?.marketCap) ?? num(primary?.fdv),
    liquidityUsd,
    volume24hUsd: pairs.reduce((sum, pair) => sum + (num(pair.volume?.h24) ?? 0), 0),
    priceChange24h: num(primary?.priceChange?.h24),
    ageHours: created.length ? (Date.now() - Math.min(...created)) / 3_600_000 : null,
    poolCount: pairs.length,
    primaryDex: primary?.dexId ?? null,
    links: linksFor(chain, address, primary, stats?.socials ?? {}),
    security: evmAudit
      ? {
          mintAuthority: evmAudit.mintable ? evmAudit.owner ?? 'unknown' : null,
          freezeAuthority: null,
          transferFeeBps: evmAudit.taxBps,
          transferFeeAuthority: evmAudit.taxChangeable ? evmAudit.owner ?? 'unknown' : null,
          permanentDelegate: null,
          contractVerified,
          honeypot: evmAudit.honeypot,
        }
      : {
          mintAuthority: security?.mintAuthority ?? null,
          freezeAuthority: security?.freezeAuthority ?? null,
          transferFeeBps: security ? security.transferFeeBps : null,
          transferFeeAuthority: security?.transferFeeAuthority ?? null,
          permanentDelegate: security?.permanentDelegate ?? null,
          contractVerified,
          honeypot: null,
        },
    holders: {
      count: holderCount,
      top10Pct,
      largestHolderPct: realHolders[0]?.pctOfSupply ?? null,
      list,
    },
    trading: {
      buys24h: stats?.buys24h ?? null,
      sells24h: stats?.sells24h ?? null,
      uniqueWallets24h,
      churn: holderCount && uniqueWallets24h !== null ? uniqueWallets24h / holderCount : null,
    },
    smartMoney,
    bundle,
    bundleAvailable: chain === 'solana',
    scannedAt: new Date().toISOString(),
  }
  return { ...base, risk: assessRisk(factsFor(base)) }
}

/** Runs the launch bundle analysis for a Solana token and measures what insiders hold now. */
export async function scanBundle(address: string): Promise<{ launch: LaunchInsiderReport; launchedAt: number; decimals: number; supply: number } | null> {
  const security = await getMintSecurity(address)
  if (!security || security.supply <= 0) return null
  const result = await analyzeLaunch(address, security.supply, SCAN_FUNDER_LOOKUPS)
  if (!result) return null
  return { launch: result.report, launchedAt: result.launchedAt, decimals: security.decimals, supply: security.supply }
}

/** Current holdings of the insider wallets, as a share of supply. Checked for the largest 20. */
export async function insiderHoldingPct(address: string, wallets: string[], decimals: number, supply: number): Promise<number> {
  let held = 0
  for (const wallet of wallets.slice(0, 20)) {
    held += await getOwnerTokenBalance(address, wallet, decimals).catch(() => 0)
  }
  return supply > 0 ? Math.round((held / supply) * 10_000) / 100 : 0
}

/** Combines a fresh bundle analysis into a scan and re-runs the verdict. */
export function withBundle(scan: ScanResult, bundle: ScanBundle): ScanResult {
  const insiderSet = new Set(bundle.insiderWallets.map((w) => w.toLowerCase()))
  const holders = scan.holders.list.map((h) => ({ ...h, isInsider: h.isInsider || insiderSet.has(h.address.toLowerCase()) }))
  const base = { ...scan, bundle, holders: { ...scan.holders, list: holders } }
  return { ...base, risk: assessRisk(factsFor(base)) }
}

export function bundleFromReport(
  report: LaunchInsiderReport,
  launchedAt: number,
  holdingPct: number
): ScanBundle {
  return {
    launchBuyers: report.launchBuyers,
    insiderWallets: report.insiderWallets,
    insiderAcquiredPct: report.insiderAcquiredPct,
    insiderHoldingPct: holdingPct,
    insiderStatus: insiderStatus(holdingPct, report.insiderAcquiredPct),
    linkedWallets: report.linkedWallets,
    clusters: report.clusters.slice(0, 5).map((c) => ({
      wallets: c.wallets,
      boughtPct: Math.round(c.boughtPct * 100) / 100,
      linkKinds: c.linkKinds,
    })),
    creationBlockSupplyPct: report.creationBlockSupplyPct,
    launchScore: report.launchScore,
    evidence: report.evidence,
    launchedAt: new Date(launchedAt * 1000).toISOString(),
  }
}
