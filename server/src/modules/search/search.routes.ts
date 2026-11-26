import { Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import * as searchService from './search.service';

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const query = searchService.searchSchema.parse({ q: req.query.q, limit: req.query.limit });
    const results = await searchService.globalSearch(req.auth!.userId, query.q, query.limit);
    res.json({ data: results });
  } catch (error) {
    next(error);
  }
});

export default router;
