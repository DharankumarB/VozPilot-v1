import { Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import * as activityService from './activity.service';

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const query = activityService.listActivitySchema.parse({
      category: req.query.category,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    const result = await activityService.listActivity(req.auth!.userId, query);
    res.json({ data: result });
  } catch (error) {
    next(error);
  }
});

router.get('/notifications', async (req, res, next) => {
  try {
    const result = await activityService.getNotifications(req.auth!.userId);
    res.json({ data: result });
  } catch (error) {
    next(error);
  }
});

export default router;
