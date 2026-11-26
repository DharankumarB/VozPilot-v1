import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import * as approvalsService from './approvals.service';

const router = Router();
router.use(requireAuth);

const listSchema = z.object({
  status: z.enum(['pending', 'resolved', 'all']).default('pending'),
});

router.get('/', async (req, res, next) => {
  try {
    const query = listSchema.parse({ status: req.query.status ?? 'pending' });
    const approvals = await approvalsService.listApprovals(req.auth!.userId, query.status);
    res.json({ data: approvals });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/resolve', async (req, res, next) => {
  try {
    const input = approvalsService.resolveApprovalSchema.parse(req.body);
    const approval = await approvalsService.resolveApproval(req.auth!.userId, req.params.id, input);
    res.json({ data: approval });
  } catch (error) {
    next(error);
  }
});

export default router;
