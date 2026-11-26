import { Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import * as workflowsService from './workflows.service';

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const workflows = await workflowsService.listWorkflows(req.auth!.userId);
    res.json({ data: workflows });
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const input = workflowsService.createWorkflowSchema.parse(req.body);
    const workflow = await workflowsService.createWorkflow(req.auth!.userId, input);
    res.status(201).json({ data: workflow });
  } catch (error) {
    next(error);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const input = workflowsService.updateWorkflowSchema.parse(req.body);
    const workflow = await workflowsService.updateWorkflow(req.auth!.userId, req.params.id, input);
    res.json({ data: workflow });
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await workflowsService.deleteWorkflow(req.auth!.userId, req.params.id);
    res.json({ data: { ok: true } });
  } catch (error) {
    next(error);
  }
});

export default router;
