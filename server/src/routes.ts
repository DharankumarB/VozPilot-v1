import { Router } from 'express';
import authRoutes from './modules/auth/auth.routes';
import agentsRoutes from './modules/agents/agents.routes';
import tasksRoutes from './modules/tasks/tasks.routes';
import workflowsRoutes from './modules/workflows/workflows.routes';
import memoriesRoutes from './modules/memories/memories.routes';
import conversationsRoutes from './modules/conversations/conversations.routes';
import approvalsRoutes from './modules/approvals/approvals.routes';
import integrationsRoutes from './modules/integrations/integrations.routes';
import activityRoutes from './modules/activity/activity.routes';
import analyticsRoutes from './modules/analytics/analytics.routes';
import settingsRoutes from './modules/settings/settings.routes';
import searchRoutes from './modules/search/search.routes';
import vozcoreRoutes from './modules/vozcore/vozcore.routes';
import { notFoundHandler } from './middleware/errorHandler';

/** Mount every API module under /api. */
export function createApiRouter(): Router {
  const api = Router();

  api.get('/health', (_req, res) => {
    res.json({ data: { status: 'ok', service: 'vozpilot-api', phase: 1 } });
  });

  api.use('/auth', authRoutes);
  api.use('/agents', agentsRoutes);
  api.use('/tasks', tasksRoutes);
  api.use('/workflows', workflowsRoutes);
  api.use('/memories', memoriesRoutes);
  api.use('/conversations', conversationsRoutes);
  api.use('/approvals', approvalsRoutes);
  api.use('/integrations', integrationsRoutes);
  api.use('/activity', activityRoutes);
  api.use('/analytics', analyticsRoutes);
  api.use('/settings', settingsRoutes);
  api.use('/search', searchRoutes);
  api.use('/vozcore', vozcoreRoutes);

  api.use(notFoundHandler);
  return api;
}
