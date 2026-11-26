import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import * as conversationsService from './conversations.service';

const router = Router();
router.use(requireAuth);

router.get('/tasks/attachable', async (req, res, next) => {
  try {
    const tasks = await conversationsService.listAttachableTasks(req.auth!.userId);
    res.json({ data: tasks });
  } catch (error) {
    next(error);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const conversations = await conversationsService.listConversations(req.auth!.userId);
    res.json({ data: conversations });
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const schema = z.object({ title: z.string().trim().max(160).optional() });
    const body = schema.parse(req.body ?? {});
    const conversation = await conversationsService.createConversation(req.auth!.userId, body.title);
    res.status(201).json({ data: conversation });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const result = await conversationsService.getConversation(req.auth!.userId, req.params.id);
    res.json({ data: result });
  } catch (error) {
    next(error);
  }
});

/**
 * Send a message. Persists the user's message only — VozCore's reply is
 * wired up in Phase 2, so no simulated assistant output is ever written.
 */
router.post('/:id/messages', async (req, res, next) => {
  try {
    const input = conversationsService.sendMessageSchema.parse(req.body);
    const result = await conversationsService.sendMessage(
      req.auth!.userId,
      req.params.id,
      input,
    );
    res.status(201).json({ data: result });
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await conversationsService.deleteConversation(req.auth!.userId, req.params.id);
    res.json({ data: { ok: true } });
  } catch (error) {
    next(error);
  }
});

export default router;
