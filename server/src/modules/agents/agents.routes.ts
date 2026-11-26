import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import * as agentsService from './agents.service';

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const agents = await agentsService.listAgents(req.auth!.userId);
    res.json({ data: agents });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const agent = await agentsService.getAgent(req.auth!.userId, req.params.id);
    res.json({ data: agent });
  } catch (error) {
    next(error);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const input = agentsService.updateAgentSchema.parse(req.body);
    const agent = await agentsService.updateAgent(req.auth!.userId, req.params.id, input);
    res.json({ data: agent });
  } catch (error) {
    next(error);
  }
});

export default router;
