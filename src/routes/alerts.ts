import { Router, Response } from 'express'
import { authMiddleware, AuthRequest } from '../middleware/auth'
import { subscriptionMiddleware } from '../middleware/subscription'
import { AlertError, createAlert, deleteAlert, listAlerts, updateAlert } from '../services/alerts-store'

/** The signed-in user's alerts. */
const router = Router()
const idOf = (req: AuthRequest) => (Array.isArray(req.params.id) ? req.params.id[0] : req.params.id)

function fail(res: Response, error: unknown, what: string) {
  if (error instanceof AlertError) return res.status(400).json({ message: error.message })
  console.error(`Failed to ${what}:`, error)
  return res.status(500).json({ message: `Could not ${what}` })
}

router.get('/', authMiddleware, subscriptionMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    res.json(await listAlerts(req.user!.id))
  } catch (error) {
    fail(res, error, 'load your alerts')
  }
})

router.post('/', authMiddleware, subscriptionMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    res.status(201).json(await createAlert(req.user!.id, req.body ?? {}))
  } catch (error) {
    fail(res, error, 'create the alert')
  }
})

router.patch('/:id', authMiddleware, subscriptionMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    res.json(await updateAlert(req.user!.id, idOf(req), req.body ?? {}))
  } catch (error) {
    fail(res, error, 'update the alert')
  }
})

router.delete('/:id', authMiddleware, subscriptionMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    await deleteAlert(req.user!.id, idOf(req))
    res.json({ success: true })
  } catch (error) {
    fail(res, error, 'delete the alert')
  }
})

export default router
