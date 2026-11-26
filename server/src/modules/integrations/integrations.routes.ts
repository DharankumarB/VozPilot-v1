import { Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import { BadRequestError } from '../../lib/errors';
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
    const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? req.protocol;
    const host = req.get('host');
    const origin = host ? `${proto}://${host}` : undefined;
    const integration = await integrationsService.connectIntegration(req.auth!.userId, provider, origin);
    res.json({ data: integration });
  } catch (error) {
    next(error);
  }
});

router.get('/oauth/:provider/callback', async (req, res, next) => {
  try {
    const { provider } = integrationsService.connectSchema.parse({ provider: req.params.provider });
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    if (!code || !state) {
      throw new BadRequestError('Missing OAuth code or state parameter.');
    }
    await integrationsService.completeOAuthCallback(req.auth!.userId, provider, code, state);
    res.redirect(`/integrations?connected=${encodeURIComponent(provider)}`);
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
