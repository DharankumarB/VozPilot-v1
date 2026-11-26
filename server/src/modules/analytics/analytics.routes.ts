import { Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import * as analyticsService from './analytics.service';

const router = Router();
router.use(requireAuth);

/** Overview dashboard payload — stats, charts and feeds (real data only). */
router.get('/overview', async (req, res, next) => {
  try {
    const overview = await analyticsService.getOverview(req.auth!.userId);
    res.json({ data: overview });
  } catch (error) {
    next(error);
  }
});

/** Analytics page payload — trends, distributions and totals. */
router.get('/', async (req, res, next) => {
  try {
    const query = analyticsService.analyticsQuerySchema.parse({ range: req.query.range });
    const analytics = await analyticsService.getAnalytics(req.auth!.userId, query.range);
    res.json({ data: analytics });
  } catch (error) {
    next(error);
  }
});

export default router;
