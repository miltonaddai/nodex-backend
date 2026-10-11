import { Router, Request, Response } from 'express'
import { chainLabel, coveredChainsText, EVM_CHAINS } from '../lib/chains'
import type { LaunchInsiderReport } from '../lib/insider-detection'
import { isValidSolanaAddress } from '../lib/validation'
import { authMiddleware } from '../middleware/auth'
import { subscriptionMiddleware } from '../middleware/subscription'
import { cacheGet, cacheSet } from '../services/redis'
import {
  bundleFromReport,
  insiderHoldingPct,
  scanBundle,
  scanToken,
  withBundle,
  type ScanBundle,
  type ScanChain,
  type ScanResult,
} from '../services/token-scanner'

const router = Router()

/** Market data and holders move fast, so a scan is only reused briefly. */
const SCAN_TTL_SECONDS = 120
/** A launch never changes, so its analysis is kept for a week. */
const LAUNCH_TTL_SECONDS = 7 * 86_400
/** What insiders hold now does change. */
const HOLDING_TTL_SECONDS = 600

function parseTarget(req: Request): { chain: ScanChain; address: string } | { error: string } {
  const chain = String(req.params.chain)
  const address = String(req.params.address).trim()
  if (chain === 'solana') {
    return isValidSolanaAddress(address) ? { chain, address } : { error: 'That is not a valid Solana token address.' }
  }
  if (EVM_CHAINS.has(chain)) {
    return /^0x[0-9a-fA-F]{40}$/.test(address)
      ? { chain: chain as ScanChain, address }
      : { error: `That is not a valid ${chainLabel(chain)} token address (0x followed by 40 hex characters).` }
  }
  return { error: `Scanning covers ${coveredChainsText()}.` }
}

async function cachedScan(chain: ScanChain, address: string): Promise<ScanResult> {
  const key = `scanner:v1:${chain}:${address}`
  const cached = await cacheGet<ScanResult>(key)
  if (cached) return cached
  const scan = await scanToken(chain, address)
  await cacheSet(key, scan, SCAN_TTL_SECONDS)
  return scan
}

/** Market, security, holders, smart money and a verdict. Returns in a few seconds. */
router.get('/:chain/:address', authMiddleware, subscriptionMiddleware, async (req: Request, res: Response) => {
  const target = parseTarget(req)
  if ('error' in target) return res.status(400).json({ message: target.error })
  try {
    const scan = await cachedScan(target.chain, target.address)
    // A bundle analysis run in the last few minutes beats the worker's stored copy.
    const bundle = await cacheGet<ScanBundle>(`scanner:bundle:v1:${target.address}`)
    return res.json(bundle ? withBundle(scan, bundle) : scan)
  } catch (err) {
    console.error('Token scan failed:', err)
    return res.status(502).json({ message: 'The scan could not be completed. Try again in a moment.' })
  }
})

/**
 * Launch bundle analysis (Solana), merged into the scan with an updated verdict. Takes up to a
 * minute the first time a token is analyzed.
 */
router.get('/:chain/:address/bundle', authMiddleware, subscriptionMiddleware, async (req: Request, res: Response) => {
  const target = parseTarget(req)
  if ('error' in target) return res.status(400).json({ message: target.error })
  if (target.chain !== 'solana') {
    return res.status(400).json({ message: 'Bundle analysis covers Solana launches only.' })
  }
  const { address } = target
  try {
    const bundleKey = `scanner:bundle:v1:${address}`
    let bundle = await cacheGet<ScanBundle>(bundleKey)
    if (!bundle) {
      const launchKey = `scanner:launch:v1:${address}`
      type Launch = { launch: LaunchInsiderReport; launchedAt: number; decimals: number; supply: number }
      let launch = await cacheGet<Launch>(launchKey)
      if (!launch) {
        launch = await scanBundle(address)
        if (!launch) return res.status(404).json({ message: 'No launch transactions were found for this token.' })
        await cacheSet(launchKey, launch, LAUNCH_TTL_SECONDS)
      }
      const holding = await insiderHoldingPct(address, launch.launch.insiderWallets, launch.decimals, launch.supply)
      bundle = bundleFromReport(launch.launch, launch.launchedAt, holding)
      await cacheSet(bundleKey, bundle, HOLDING_TTL_SECONDS)
    }
    const scan = await cachedScan('solana', address)
    return res.json(withBundle(scan, bundle))
  } catch (err) {
    console.error('Bundle scan failed:', err)
    return res.status(502).json({ message: 'The bundle analysis could not be completed. Try again in a moment.' })
  }
})

export default router
