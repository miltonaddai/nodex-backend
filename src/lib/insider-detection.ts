/**
 * Launch-insider detection.
 *
 * Built from a manual review of Super Inu (DEW9dSN6…), which went $45k → $2M in its first
 * 15 minutes, retraced to $667k and then ran to $24.5M. Its launch showed the fingerprints this
 * module scores:
 *
 *   - Three wallets co-signed a single buy in the creation block for 11.9% of supply. Only one
 *     person can sign for all three, so co-signing is proof of common control.
 *   - Two of them were funded in the same minute by one private wallet (not an exchange).
 *   - A launch buyer split its bag into fresh wallets that had spent no SOL of their own.
 *   - Buy waves of near-identical size landed in the same slot.
 *
 * Shared funders are only evidence when the funder is private. Exchange hot wallets and wallet
 * services fund thousands of unrelated users, so callers pass those in `hotWallets` and they
 * are ignored. In the review, 3 of 4 shared funders were exactly that.
 *
 * Launchpad and pool accounts appear in almost every launch transaction, so any owner seen in
 * a large share of them is treated as infrastructure rather than a buyer.
 */

export interface EnhancedTokenBalanceChange {
  userAccount?: string
  mint?: string
  rawTokenAmount?: { tokenAmount?: string; decimals?: number }
}

export interface EnhancedAccountData {
  account?: string
  nativeBalanceChange?: number
  tokenBalanceChanges?: EnhancedTokenBalanceChange[]
}

export interface LaunchTransaction {
  signature?: string
  slot?: number
  timestamp?: number
  feePayer?: string
  transactionError?: unknown
  accountData?: EnhancedAccountData[]
}

export interface LaunchBuyer {
  wallet: string
  /** Slots after the first launch transaction. 0 means the creation block. */
  firstSlotOffset: number
  firstSecondOffset: number
  /** Tokens received from launchpad or pool accounts, i.e. bought. */
  bought: number
  /** Tokens received from other wallets, i.e. split to it. */
  received: number
  sent: number
  solSpent: number
}

export type LinkKind = 'co_signed' | 'fee_paid' | 'split' | 'shared_funder'

export interface WalletLink {
  kind: LinkKind
  a: string
  b: string
}

export interface LaunchActivity {
  buyers: Map<string, LaunchBuyer>
  links: WalletLink[]
  infrastructure: Set<string>
  firstSlot: number
  firstTimestamp: number
  transactions: number
}

export interface InsiderCluster {
  wallets: string[]
  boughtPct: number
  linkKinds: LinkKind[]
}

export interface LaunchInsiderReport {
  launchBuyers: number
  launchSupplyPct: number
  creationBlockSupplyPct: number
  linkedWallets: number
  linkedSupplyPct: number
  clusters: InsiderCluster[]
  largestClusterSupplyPct: number
  coSignedLinks: number
  feePaidLinks: number
  splitTransfers: number
  sharedFunderLinks: number
  /** Linked wallets plus large creation-block buyers, largest buyers first. */
  insiderWallets: string[]
  /** Share of supply the insider wallets acquired at launch, bought or split to them. */
  insiderAcquiredPct: number
  launchScore: number
  evidence: string[]
}

const INFRA_MIN_APPEARANCES = 15
/**
 * A fee payer covering buys for this many different wallets across separate transactions is a
 * trading-platform relayer, not an insider. In the review one such service paid for 11 buyers.
 */
const RELAYER_MIN_BENEFICIARIES = 4
const INFRA_MIN_SHARE = 0.05
/** Creation-block buyers below this share of supply are ordinary snipers, not insiders. */
const CREATION_BLOCK_INSIDER_MIN_PCT = 0.5
const MAX_INSIDER_WALLETS = 50

function tokenDeltas(tx: LaunchTransaction, mint: string): Map<string, number> {
  const deltas = new Map<string, number>()
  for (const account of tx.accountData ?? []) {
    for (const change of account.tokenBalanceChanges ?? []) {
      if (change.mint !== mint || !change.userAccount) continue
      const raw = Number(change.rawTokenAmount?.tokenAmount ?? 0)
      const decimals = Number(change.rawTokenAmount?.decimals ?? 0)
      if (!Number.isFinite(raw) || raw === 0) continue
      const amount = raw / 10 ** decimals
      deltas.set(change.userAccount, (deltas.get(change.userAccount) ?? 0) + amount)
    }
  }
  return deltas
}

function solDelta(tx: LaunchTransaction, wallet: string): number {
  const entry = (tx.accountData ?? []).find((account) => account.account === wallet)
  return Number(entry?.nativeBalanceChange ?? 0) / 1e9
}

/**
 * Turns a token's earliest transactions into per-wallet positions and direct links between
 * wallets. The launch window starts at the first token movement, not the first transaction:
 * some launchpads create the mint minutes before trading opens.
 */
export function collectLaunchActivity(
  transactions: LaunchTransaction[],
  mint: string,
  windowSeconds = Number.POSITIVE_INFINITY
): LaunchActivity {
  // Helius's parse endpoint does not return transactions in the order requested, so order by
  // slot. The sort is stable, which keeps the caller's within-slot order.
  const ordered = transactions
    .filter((tx) => !tx.transactionError && tx.slot !== undefined)
    .sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))
    .map((tx) => ({ tx, deltas: tokenDeltas(tx, mint) }))
  const opening = ordered.find(({ deltas }) => deltas.size > 0)?.tx
  const perTx = opening
    ? ordered.filter(
        ({ tx }) =>
          (tx.slot ?? 0) >= (opening.slot ?? 0) &&
          (tx.timestamp ?? 0) <= (opening.timestamp ?? 0) + windowSeconds
      )
    : []
  const successful = perTx.map(({ tx }) => tx)

  const appearances = new Map<string, number>()
  for (const { deltas } of perTx) {
    for (const owner of deltas.keys()) appearances.set(owner, (appearances.get(owner) ?? 0) + 1)
  }
  const infraThreshold = Math.max(INFRA_MIN_APPEARANCES, perTx.length * INFRA_MIN_SHARE)
  const infrastructure = new Set(
    [...appearances.entries()].filter(([, count]) => count >= infraThreshold).map(([owner]) => owner)
  )

  const firstSlot = successful[0]?.slot ?? 0
  const firstTimestamp = successful[0]?.timestamp ?? 0
  const buyers = new Map<string, LaunchBuyer>()
  const links: WalletLink[] = []
  const feePaid: WalletLink[] = []
  const buyerFor = (wallet: string, tx: LaunchTransaction): LaunchBuyer => {
    let buyer = buyers.get(wallet)
    if (!buyer) {
      buyer = {
        wallet,
        firstSlotOffset: (tx.slot ?? firstSlot) - firstSlot,
        firstSecondOffset: (tx.timestamp ?? firstTimestamp) - firstTimestamp,
        bought: 0,
        received: 0,
        sent: 0,
        solSpent: 0,
      }
      buyers.set(wallet, buyer)
    }
    return buyer
  }

  for (const { tx, deltas } of perTx) {
    const fromInfra = [...deltas.entries()].some(([owner, delta]) => infrastructure.has(owner) && delta < 0)
    const gainers = [...deltas.entries()].filter(([owner, delta]) => delta > 0 && !infrastructure.has(owner))
    const losers = [...deltas.entries()].filter(([owner, delta]) => delta < 0 && !infrastructure.has(owner))

    for (const [wallet, delta] of gainers) {
      const buyer = buyerFor(wallet, tx)
      if (fromInfra) {
        buyer.bought += delta
        buyer.solSpent += Math.max(0, -solDelta(tx, wallet))
      } else {
        buyer.received += delta
      }
    }
    for (const [wallet, delta] of losers) buyerFor(wallet, tx).sent += -delta

    // Several receiving wallets that each paid SOL in one transaction all signed it, so one
    // person holds all their keys. Receivers that paid nothing may be fee or referral accounts.
    if (fromInfra) {
      const signers = gainers.filter(([wallet]) => solDelta(tx, wallet) < 0)
      for (let i = 1; i < signers.length; i++) {
        links.push({ kind: 'co_signed', a: signers[0][0], b: signers[i][0] })
      }
    }

    const payer = tx.feePayer
    if (fromInfra && payer && !infrastructure.has(payer)) {
      for (const [wallet] of gainers) {
        if (wallet !== payer && solDelta(tx, wallet) >= 0) feePaid.push({ kind: 'fee_paid', a: payer, b: wallet })
      }
    }

    // A wallet signing away tokens to other wallets, with no pool involved, is splitting its
    // bag. Requiring the sender to be the signer excludes aggregator routes, which pass tokens
    // through intermediate accounts the trader does not sign for.
    if (!fromInfra && payer && losers.length === 1 && losers[0][0] === payer) {
      for (const [to] of gainers) {
        if (to !== payer) links.push({ kind: 'split', a: payer, b: to })
      }
    }
  }

  const beneficiaries = new Map<string, Set<string>>()
  for (const link of feePaid) {
    const set = beneficiaries.get(link.a) ?? new Set<string>()
    set.add(link.b)
    beneficiaries.set(link.a, set)
  }
  for (const link of feePaid) {
    if ((beneficiaries.get(link.a)?.size ?? 0) < RELAYER_MIN_BENEFICIARIES) links.push(link)
  }

  return { buyers, links, infrastructure, firstSlot, firstTimestamp, transactions: perTx.length }
}

/** Links wallets that were funded by the same private wallet. */
export function sharedFunderLinks(
  funders: Map<string, string | null>,
  hotWallets: Set<string>
): WalletLink[] {
  const byFunder = new Map<string, string[]>()
  for (const [wallet, funder] of funders) {
    if (!funder || hotWallets.has(funder)) continue
    const group = byFunder.get(funder) ?? []
    group.push(wallet)
    byFunder.set(funder, group)
  }
  const links: WalletLink[] = []
  for (const group of byFunder.values()) {
    for (let i = 1; i < group.length; i++) links.push({ kind: 'shared_funder', a: group[0], b: group[i] })
  }
  return links
}

/** Funders shared by two or more wallets, which need a hot-wallet check before they count. */
export function sharedFunders(funders: Map<string, string | null>): string[] {
  const counts = new Map<string, number>()
  for (const funder of funders.values()) {
    if (funder) counts.set(funder, (counts.get(funder) ?? 0) + 1)
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([funder]) => funder)
}

function clusterWallets(links: WalletLink[]): Map<string, string> {
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    const p = parent.get(x) ?? x
    if (p === x) return x
    const root = find(p)
    parent.set(x, root)
    return root
  }
  for (const { a, b } of links) {
    if (!parent.has(a)) parent.set(a, a)
    if (!parent.has(b)) parent.set(b, b)
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  const roots = new Map<string, string>()
  for (const wallet of parent.keys()) roots.set(wallet, find(wallet))
  return roots
}

function pct(amount: number, supply: number): number {
  return supply > 0 ? (amount / supply) * 100 : 0
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

export function scoreLaunch(activity: LaunchActivity, extraLinks: WalletLink[], supply: number): LaunchInsiderReport {
  const buyers = [...activity.buyers.values()]
  const links = [...activity.links, ...extraLinks]
  const roots = clusterWallets(links)

  const clusterMap = new Map<string, { wallets: Set<string>; kinds: Set<LinkKind> }>()
  for (const link of links) {
    const root = roots.get(link.a)!
    const entry = clusterMap.get(root) ?? { wallets: new Set<string>(), kinds: new Set<LinkKind>() }
    entry.wallets.add(link.a)
    entry.wallets.add(link.b)
    entry.kinds.add(link.kind)
    clusterMap.set(root, entry)
  }
  // Net position at the end of the window. Gross buys overcount wallets that flip in and out
  // during the launch, and a split bag would be counted for both sender and receiver.
  const heldOf = (wallet: string) => {
    const buyer = activity.buyers.get(wallet)
    return buyer ? Math.max(0, buyer.bought + buyer.received - buyer.sent) : 0
  }

  const clusters: InsiderCluster[] = [...clusterMap.values()]
    .map(({ wallets, kinds }) => ({
      wallets: [...wallets].sort((x, y) => heldOf(y) - heldOf(x)),
      boughtPct: pct([...wallets].reduce((sum, w) => sum + heldOf(w), 0), supply),
      linkKinds: [...kinds],
    }))
    .filter((cluster) => cluster.wallets.length > 1)
    .sort((x, y) => y.boughtPct - x.boughtPct)

  const linked = new Set(clusters.flatMap((cluster) => cluster.wallets))
  const launchBought = buyers.reduce((sum, b) => sum + heldOf(b.wallet), 0)
  const creationBlock = buyers.filter((b) => b.firstSlotOffset === 0 && b.bought > 0)
  const creationBlockBought = creationBlock.reduce((sum, b) => sum + heldOf(b.wallet), 0)
  const linkedBought = [...linked].reduce((sum, w) => sum + heldOf(w), 0)

  const count = (kind: LinkKind) => links.filter((link) => link.kind === kind).length
  const coSigned = count('co_signed')
  const feePaid = count('fee_paid')
  const splits = count('split')
  const funderLinks = count('shared_funder')

  const insiderSet = new Set(linked)
  for (const buyer of creationBlock) {
    if (pct(heldOf(buyer.wallet), supply) >= CREATION_BLOCK_INSIDER_MIN_PCT) insiderSet.add(buyer.wallet)
  }
  const insiderWallets = [...insiderSet]
    .filter((wallet) => heldOf(wallet) > 0)
    .sort((x, y) => heldOf(y) - heldOf(x))
    .slice(0, MAX_INSIDER_WALLETS)
  const insiderAcquired = insiderWallets.reduce((sum, wallet) => sum + heldOf(wallet), 0)

  const linkedSupplyPct = pct(linkedBought, supply)
  const creationBlockSupplyPct = pct(creationBlockBought, supply)
  const largestClusterSupplyPct = clusters[0]?.boughtPct ?? 0

  const launchScore = Math.min(
    100,
    Math.min(40, linkedSupplyPct) +
      Math.min(25, creationBlockSupplyPct * 1.25) +
      Math.min(15, clusters.length * 5) +
      Math.min(10, coSigned * 5 + splits * 3) +
      Math.min(10, feePaid * 2 + funderLinks * 2)
  )

  const evidence: string[] = []
  const signedGroups = clusters.filter((c) => c.linkKinds.includes('co_signed') && c.boughtPct >= 0.5)
  for (const cluster of signedGroups.slice(0, 2)) {
    evidence.push(
      `${cluster.wallets.length} wallets co-signed launch buys for ${round(cluster.boughtPct)}% of supply — one person controls them`
    )
  }
  if (creationBlockSupplyPct >= 1) {
    evidence.push(`${creationBlock.length} wallets took ${round(creationBlockSupplyPct)}% of supply in the creation block`)
  }
  if (funderLinks > 0) {
    const funded = new Set(links.filter((l) => l.kind === 'shared_funder').flatMap((l) => [l.a, l.b]))
    evidence.push(`${funded.size} launch buyers were funded by the same private wallet`)
  }
  if (splits > 0) evidence.push(`${splits} launch-window transfers split tokens into other wallets`)
  if (feePaid > 0) evidence.push(`${feePaid} launch buys had their fees paid by another wallet`)
  if (linkedSupplyPct >= 1 && signedGroups.length === 0 && clusters.length > 0) {
    evidence.push(`${linked.size} linked wallets bought ${round(linkedSupplyPct)}% of supply at launch`)
  }

  return {
    launchBuyers: buyers.filter((b) => b.bought > 0).length,
    launchSupplyPct: round(pct(launchBought, supply), 2),
    creationBlockSupplyPct: round(creationBlockSupplyPct, 2),
    linkedWallets: linked.size,
    linkedSupplyPct: round(linkedSupplyPct, 2),
    clusters,
    largestClusterSupplyPct: round(largestClusterSupplyPct, 2),
    coSignedLinks: coSigned,
    feePaidLinks: feePaid,
    splitTransfers: splits,
    sharedFunderLinks: funderLinks,
    insiderWallets,
    insiderAcquiredPct: round(pct(insiderAcquired, supply), 2),
    launchScore: round(launchScore),
    evidence,
  }
}

export type PricePattern = 'reclaiming' | 'retracing' | 'new_highs' | 'ranging' | 'unknown'

export interface PriceShape {
  launchHighMc: number
  postLaunchLowMc: number
  athMc: number
  currentMc: number
  pattern: PricePattern
}

const LAUNCH_HIGH_WINDOW_SECONDS = 6 * 3600

/**
 * The shape Super Inu showed: a launch spike, a deep retrace, then a sustained reclaim. The
 * retrace is where insiders who still hold can reload cheaply, and the reclaim is when that
 * becomes visible.
 */
export function classifyPriceShape(
  series: { unixTime: number; value: number }[],
  supply: number,
  launchedAt: number,
  currentMc: number
): PriceShape {
  const points = series.filter((p) => Number.isFinite(p.value) && p.value > 0).sort((a, b) => a.unixTime - b.unixTime)
  if (points.length === 0 || supply <= 0) {
    return { launchHighMc: 0, postLaunchLowMc: 0, athMc: currentMc, currentMc, pattern: 'unknown' }
  }
  const mc = (value: number) => value * supply
  const launchPoints = points.filter((p) => p.unixTime <= launchedAt + LAUNCH_HIGH_WINDOW_SECONDS)
  const launchHigh = (launchPoints.length ? launchPoints : points.slice(0, 1)).reduce((best, p) => (p.value > best.value ? p : best))
  const after = points.filter((p) => p.unixTime > launchHigh.unixTime)
  const low = after.length ? after.reduce((best, p) => (p.value < best.value ? p : best)).value : launchHigh.value
  const ath = Math.max(...points.map((p) => p.value))
  const current = currentMc > 0 ? currentMc : mc(points[points.length - 1].value)

  const launchHighMc = mc(launchHigh.value)
  const postLaunchLowMc = mc(low)
  // The launch high is only settled once the launch window has passed.
  const settled = points[points.length - 1].unixTime - launchedAt >= LAUNCH_HIGH_WINDOW_SECONDS
  let pattern: PricePattern = 'ranging'
  if (!settled) pattern = 'unknown'
  else if (postLaunchLowMc <= launchHighMc * 0.5 && current >= postLaunchLowMc * 2) pattern = 'reclaiming'
  else if (current <= launchHighMc * 0.5) pattern = 'retracing'
  else if (current >= launchHighMc) pattern = 'new_highs'

  return { launchHighMc, postLaunchLowMc, athMc: Math.max(mc(ath), current), currentMc: current, pattern }
}

/**
 * Overall score: how strongly insiders controlled the launch, and whether they still hold.
 * A heavily bundled launch whose insiders have sold is history. One whose insiders still hold
 * a meaningful share is the live setup.
 */
export function insiderScore(launchScore: number, insiderHoldingPct: number, insiderAcquiredPct: number): number {
  const retained = insiderAcquiredPct > 0 ? Math.min(1, insiderHoldingPct / insiderAcquiredPct) : 0
  const holding = Math.min(30, insiderHoldingPct * 3) * (0.5 + retained / 2)
  return round(Math.min(100, launchScore * 0.7 + holding))
}

export type InsiderStatus = 'holding' | 'distributing' | 'exited' | 'unknown'

export function insiderStatus(insiderHoldingPct: number, insiderAcquiredPct: number): InsiderStatus {
  if (insiderAcquiredPct <= 0) return 'unknown'
  const retained = insiderHoldingPct / insiderAcquiredPct
  if (retained <= 0.2) return 'exited'
  if (insiderHoldingPct >= 3 && retained >= 0.5) return 'holding'
  return 'distributing'
}
