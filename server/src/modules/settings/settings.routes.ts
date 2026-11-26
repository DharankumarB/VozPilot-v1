import { Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import * as settingsService from './settings.service';

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const settings = await settingsService.getSettings(req.auth!.userId);
    res.json({ data: settings });
  } catch (error) {
    next(error);
  }
});

router.patch('/profile', async (req, res, next) => {
  try {
    const input = settingsService.profileSchema.parse(req.body);
    const profile = await settingsService.updateProfile(req.auth!.userId, input);
    res.json({ data: { profile } });
  } catch (error) {
    next(error);
  }
});

router.patch('/appearance', async (req, res, next) => {
  try {
    const input = settingsService.appearanceSchema.parse(req.body);
    const preferences = await settingsService.updateAppearance(req.auth!.userId, input);
    res.json({ data: { preferences } });
  } catch (error) {
    next(error);
  }
});

router.patch('/notifications', async (req, res, next) => {
  try {
    const input = settingsService.notificationsSchema.parse(req.body);
    const preferences = await settingsService.updateNotifications(req.auth!.userId, input);
    res.json({ data: { preferences } });
  } catch (error) {
    next(error);
  }
});

router.patch('/agent-defaults', async (req, res, next) => {
  try {
    const input = settingsService.agentDefaultsSchema.parse(req.body);
    const preferences = await settingsService.updateAgentDefaults(req.auth!.userId, input);
    res.json({ data: { preferences } });
  } catch (error) {
    next(error);
  }
});

export default router;
