import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import * as memoriesService from './memories.service';

const router = Router();
router.use(requireAuth);

const listSchema = z.object({
  q: z.string().max(200).optional(),
  category: z.string().max(60).optional(),
});

router.get('/', async (req, res, next) => {
  try {
    const query = listSchema.parse({ q: req.query.q, category: req.query.category });
    const result = await memoriesService.listMemories(req.auth!.userId, query);
    res.json({ data: result });
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const input = memoriesService.createMemorySchema.parse(req.body);
    const memory = await memoriesService.createMemory(req.auth!.userId, input);
    res.status(201).json({ data: memory });
  } catch (error) {
    next(error);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const input = memoriesService.updateMemorySchema.parse(req.body);
    const memory = await memoriesService.updateMemory(req.auth!.userId, req.params.id, input);
    res.json({ data: memory });
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await memoriesService.deleteMemory(req.auth!.userId, req.params.id);
    res.json({ data: { ok: true } });
  } catch (error) {
    next(error);
  }
});

export default router;
