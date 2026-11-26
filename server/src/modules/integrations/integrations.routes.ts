import { Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import * as integrationsService from './integrations.service';

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const integrations = await integrationsService.listIntegrations(req.auth!.userId);
    res.json({ data: integrations });
  } catch (error) {
    next(error);
  }
});

router.post('/:provider/connect', async (req, res, next) => {
  try {
    const { provider } = integrationsService.connectSchema.parse({ provider: req.params.provider });
    const integration = await integrationsService.connectIntegration(req.auth!.userId, provider);
    res.json({ data: integration });
  } catch (error) {
    next(error);
  }
});

router.post('/:provider/disconnect', async (req, res, next) => {
  try {
    const { provider } = integrationsService.connectSchema.parse({ provider: req.params.provider });
    const integration = await integrationsService.disconnectIntegration(req.auth!.userId, provider);
    res.json({ data: integration });
  } catch (error) {
    next(error);
  }
});

export default router;
