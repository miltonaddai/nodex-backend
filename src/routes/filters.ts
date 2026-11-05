import { Router, Response } from 'express'
import { authMiddleware, AuthRequest } from '../middleware/auth'
import { subscriptionMiddleware } from '../middleware/subscription'
import { deleteSavedFilter, listSavedFilters, saveFilter, SavedFilterError } from '../services/saved-filters-store'

/** The signed-in user's saved custom filters for the Smart Wallets table. Alerts live in routes/alerts. */
const router = Router()

router.get('/', authMiddleware, subscriptionMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    res.json(await listSavedFilters(req.user!.id))
  } catch (error) {
    console.error('Failed to list saved filters:', error)
    res.status(500).json({ message: 'Could not load your saved filters' })
  }
})

router.post('/', authMiddleware, subscriptionMiddleware, async (req: AuthRequest, res: Response) => {
  const name = typeof req.body?.name === 'string' ? req.body.name : ''
  try {
    res.status(201).json(await saveFilter(req.user!.id, name, req.body?.rules))
  } catch (error) {
    if (error instanceof SavedFilterError) return res.status(400).json({ message: error.message })
    console.error('Failed to save filter:', error)
    res.status(500).json({ message: 'Could not save the filter' })
  }
})

router.delete('/:id', authMiddleware, subscriptionMiddleware, async (req: AuthRequest, res: Response) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id
  try {
    await deleteSavedFilter(req.user!.id, id)
    res.json({ success: true })
  } catch (error) {
    console.error('Failed to delete saved filter:', error)
    res.status(500).json({ message: 'Could not delete the filter' })
  }
})

export default router
