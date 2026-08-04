import { Router, Response } from 'express'
import { authMiddleware, AuthRequest } from '../middleware/auth'
import { subscriptionMiddleware } from '../middleware/subscription'
import { getWalletBalance } from '../services/alchemy'
import { isDemoMode } from '../services/demo-auth'
import {
  addWatchlistWallet,
  listWatchlist,
  removeWatchlistWallet,
  renameWatchlistWallet,
} from '../services/watchlist-store'
import {
  addWatchlistToken,
  listWatchlistTokens,
  removeWatchlistToken,
} from '../services/token-watchlist-store'

const router = Router()
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isInvalidPersistedId(id: string): boolean {
  return !isDemoMode() && !UUID_PATTERN.test(id)
}

// Token routes are declared before the wallet ':id' routes so that "/tokens" is never
// swallowed by the parameterised wallet paths below.
router.get('/tokens', authMiddleware, subscriptionMiddleware, async (req: AuthRequest, res: Response) => {
  const chain = (req.query.chain as string) || 'solana'

  try {
    const tokens = await listWatchlistTokens(req.user!.id, chain)
    res.json(tokens)
  } catch (error) {
    console.error('Failed to load token watchlist:', error)
    res.status(500).json({ message: 'Failed to load token watchlist' })
  }
})

router.post('/tokens', authMiddleware, subscriptionMiddleware, async (req: AuthRequest, res: Response) => {
  const contract = typeof req.body.contract === 'string' ? req.body.contract.trim() : ''
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : ''
  const symbol = typeof req.body.symbol === 'string' ? req.body.symbol.trim() : ''
  const chain = typeof req.body.chain === 'string' ? req.body.chain : 'solana'

  if (!contract || !name || !symbol) {
    return res.status(400).json({ message: 'contract, name, and symbol are required' })
  }

  try {
    // The store upserts on (user_id, contract, chain), so re-adding a tracked token is a no-op
    // that returns the existing row rather than a duplicate-key error.
    const token = await addWatchlistToken(req.user!.id, { contract, name, symbol, chain })
    res.status(201).json(token)
  } catch (error) {
    console.error('Failed to add watchlist token:', error)
    res.status(500).json({ message: 'Failed to add token to watchlist' })
  }
})

router.delete('/tokens/:id', authMiddleware, subscriptionMiddleware, async (req: AuthRequest, res: Response) => {
  const tokenId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id
  const chain = (req.query.chain as string) || 'solana'
  if (!tokenId) return res.status(400).json({ message: 'Token id is required' })
  if (isInvalidPersistedId(tokenId)) {
    return res.status(400).json({ message: 'Token id must be a valid UUID' })
  }

  try {
    await removeWatchlistToken(req.user!.id, tokenId, chain)
    res.json({ success: true })
  } catch (error) {
    console.error('Failed to remove watchlist token:', error)
    res.status(500).json({ message: 'Failed to remove token from watchlist' })
  }
})

router.get('/', authMiddleware, subscriptionMiddleware, async (req: AuthRequest, res: Response) => {
  const chain = (req.query.chain as string) || 'solana'

  try {
    const wallets = await listWatchlist(req.user?.id, chain)
    res.json(wallets)
  } catch (error) {
    console.error('Failed to load watchlist:', error)
    res.status(500).json({ message: 'Failed to load watchlist' })
  }
})

router.post('/', authMiddleware, subscriptionMiddleware, async (req: AuthRequest, res: Response) => {
  const { address, name, chain } = req.body
  if (!address || !name || !chain) {
    return res.status(400).json({ message: 'address, name, and chain are required' })
  }

  try {
    const balance = (await getWalletBalance(address, chain)) ?? 0
    const wallet = await addWatchlistWallet(req.user!.id, {
      address,
      name,
      chain,
      balance: Math.round(balance * 150),
    })
    res.status(201).json(wallet)
  } catch (error) {
    console.error('Failed to add watchlist wallet:', error)
    res.status(500).json({ message: 'Failed to add wallet to watchlist' })
  }
})

router.patch('/:id', authMiddleware, subscriptionMiddleware, async (req: AuthRequest, res: Response) => {
  const walletId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : ''
  const chain = typeof req.body.chain === 'string' ? req.body.chain : 'solana'
  if (!walletId) return res.status(400).json({ message: 'Wallet id is required' })
  if (isInvalidPersistedId(walletId)) {
    return res.status(400).json({ message: 'Wallet id must be a valid UUID' })
  }
  if (!name || name.length > 64) {
    return res.status(400).json({ message: 'Wallet name must be between 1 and 64 characters' })
  }

  try {
    const wallet = await renameWatchlistWallet(req.user!.id, walletId, name, chain)
    res.json(wallet)
  } catch (error) {
    console.error('Failed to rename watchlist wallet:', error)
    res.status(500).json({ message: 'Failed to rename wallet' })
  }
})

router.delete('/:id', authMiddleware, subscriptionMiddleware, async (req: AuthRequest, res: Response) => {
  const walletId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id
  const chain = (req.query.chain as string) || 'solana'
  if (!walletId) return res.status(400).json({ message: 'Wallet id is required' })
  if (isInvalidPersistedId(walletId)) {
    return res.status(400).json({ message: 'Wallet id must be a valid UUID' })
  }

  try {
    await removeWatchlistWallet(req.user!.id, walletId, chain)
    res.json({ success: true })
  } catch (error) {
    console.error('Failed to remove watchlist wallet:', error)
    res.status(500).json({ message: 'Failed to remove wallet from watchlist' })
  }
})

export default router
