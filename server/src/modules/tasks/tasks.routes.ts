import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import * as tasksService from './tasks.service';

const router = Router();
router.use(requireAuth);

const listQuerySchema = z.object({
  q: z.string().max(200).optional(),
  status: z.enum(['all', 'pending', 'in_progress', 'waiting_approval', 'completed', 'failed']).optional(),
  priority: z.enum(['all', 'low', 'medium', 'high', 'critical']).optional(),
  agentId: z.string().max(64).optional(),
  sort: z.enum(['created_desc', 'updated_desc', 'due_asc', 'priority_desc']).optional(),
});

router.get('/', async (req, res, next) => {
  try {
    const query = listQuerySchema.parse({
      q: req.query.q,
      status: req.query.status,
      priority: req.query.priority,
      agentId: req.query.agentId,
      sort: req.query.sort,
    });
    const result = await tasksService.listTasks(req.auth!.userId, query);
    res.json({ data: result });
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const input = tasksService.createTaskSchema.parse(req.body);
    const task = await tasksService.createTask(req.auth!.userId, input);
    res.status(201).json({ data: task });
  } catch (error) {
    next(error);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const input = tasksService.updateTaskSchema.parse(req.body);
    const task = await tasksService.updateTask(req.auth!.userId, req.params.id, input);
    res.json({ data: task });
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await tasksService.deleteTask(req.auth!.userId, req.params.id);
    res.json({ data: { ok: true } });
  } catch (error) {
    next(error);
  }
});

export default router;
