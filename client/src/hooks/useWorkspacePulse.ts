import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { Agent } from '../lib/types';

/**
 * Lightweight heartbeat for the top bar: how many agents are active.
 * Refreshes every 60s and whenever the window regains focus.
 */
export function useWorkspacePulse(): { activeAgents: number; totalAgents: number; refresh: () => void } {
  const [state, setState] = useState({ activeAgents: 0, totalAgents: 0 });

  const refresh = useCallback(() => {
    api
      .get<Agent[]>('/api/agents')
      .then((agents) => {
        setState({
          totalAgents: agents.length,
          activeAgents: agents.filter((agent) => agent.status === 'active').length,
        });
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refresh();
    const interval = window.setInterval(refresh, 60_000);
    window.addEventListener('focus', refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refresh);
    };
  }, [refresh]);

  return { ...state, refresh };
}
