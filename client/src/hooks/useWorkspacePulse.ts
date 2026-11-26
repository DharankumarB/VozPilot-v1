import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { Agent } from '../lib/types';
import { vozcore } from '../lib/vozcore';

export const WORKSPACE_PAUSE_EVENT = 'vozpilot:pause-changed';

/**
 * Lightweight heartbeat for the top bar: how many agents are active
 * and whether the workspace-wide Pause All Agents switch is engaged.
 */
export function useWorkspacePulse(): {
  activeAgents: number;
  totalAgents: number;
  agentsPaused: boolean;
  refresh: () => void;
} {
  const [state, setState] = useState({ activeAgents: 0, totalAgents: 0, agentsPaused: false });

  const refresh = useCallback(() => {
    api
      .get<Agent[]>('/api/agents')
      .then((agents) => {
        setState((prev) => ({
          ...prev,
          totalAgents: agents.length,
          activeAgents: agents.filter((agent) => agent.status === 'active' && agent.enabled !== false).length,
        }));
      })
      .catch(() => undefined);

    vozcore
      .health()
      .then((health) => {
        setState((prev) => ({
          ...prev,
          agentsPaused: Boolean(health.agentsPaused),
        }));
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refresh();
    const interval = window.setInterval(refresh, 45_000);
    window.addEventListener('focus', refresh);
    window.addEventListener(WORKSPACE_PAUSE_EVENT, refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refresh);
      window.removeEventListener(WORKSPACE_PAUSE_EVENT, refresh);
    };
  }, [refresh]);

  return { ...state, refresh };
}
