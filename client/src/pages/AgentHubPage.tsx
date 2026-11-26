import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Bot, Search, Sparkles } from 'lucide-react';
import { api, qs } from '../lib/api';
import type { Agent, AgentStatus } from '../lib/types';
import { useToast } from '../context/ToastContext';
import { errorMessage } from '../context/AuthContext';
import { PageHeader } from '../components/PageHeader';
import { StatusPill, Chip } from '../components/ui/Badge';
import { EmptyState, ListSkeleton } from '../components/ui/Feedback';
import { AGENT_STATUS_META, agentIcon } from '../lib/constants';
import { cn, formatRelative } from '../lib/utils';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

const FILTERS: { id: AgentStatus | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'idle', label: 'Idle' },
  { id: 'paused', label: 'Paused' },
  { id: 'error', label: 'Error' },
];

export function AgentHubPage() {
  useDocumentTitle('Agent Hub · VozPilot');
  const toast = useToast();

  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [filter, setFilter] = useState<AgentStatus | 'all'>('all');
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    api
      .get<Agent[]>('/api/agents')
      .then(setAgents)
      .catch((caught) => setError(errorMessage(caught)));
  }, []);

  useEffect(load, [load]);

  const visible = useMemo(() => {
    if (!agents) return [];
    const term = search.trim().toLowerCase();
    return agents.filter((agent) => {
      if (filter !== 'all' && agent.status !== filter) return false;
      if (term && !`${agent.name} ${agent.description}`.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [agents, filter, search]);

  const counts = useMemo(() => {
    const base: Record<string, number> = { all: agents?.length ?? 0 };
    for (const status of ['active', 'idle', 'paused', 'error'] as AgentStatus[]) {
      base[status] = agents?.filter((agent) => agent.status === status).length ?? 0;
    }
    return base;
  }, [agents]);

  return (
    <div className="anim-enter flex flex-col gap-6">
      <PageHeader
        title="Agent Hub"
        subtitle="Nine specialist profiles — configure status, description and responsibilities. VozCore delegates real work to enabled agents."
        actions={
          <div className="relative">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-mist-500" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search agents…"
              aria-label="Search agents"
              className="focus-ring h-9 w-56 rounded-xl border border-white/10 bg-white/4 pl-9 pr-3 text-sm text-mist-100 placeholder:text-mist-500 focus:border-[var(--accent)]"
            />
          </div>
        }
      />

      {/* Status filter chips */}
      <div className="flex flex-wrap gap-2">
        {FILTERS.map((item) => (
          <Chip key={item.id} active={filter === item.id} onClick={() => setFilter(item.id)}>
            {item.label}
            <span className={cn('font-mono', filter === item.id ? 'text-[var(--accent)]' : 'text-mist-600')}>
              {counts[item.id] ?? 0}
            </span>
          </Chip>
        ))}
      </div>

      {error && !agents ? (
        <EmptyState title="Couldn't load agents" description={error} action={<button type="button" onClick={load} className="focus-ring rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white">Retry</button>} />
      ) : !agents ? (
        <ListSkeleton rows={4} />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={<Bot size={20} />}
          title={agents.length === 0 ? 'No agents yet' : 'No agents match your filters'}
          description={
            agents.length === 0
              ? 'Agent profiles are seeded when a workspace is created.'
              : 'Try a different status filter or clear the search.'
          }
          action={
            agents.length > 0 ? (
              <button
                type="button"
                onClick={() => {
                  setFilter('all');
                  setSearch('');
                }}
                className="focus-ring rounded-lg border border-white/12 px-4 py-2 text-sm text-mist-300 hover:bg-white/6"
              >
                Clear filters
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((agent) => {
            const Icon = agentIcon(agent.icon);
            const meta = AGENT_STATUS_META[agent.status];
            const isVozCore = agent.key === 'vozcore';
            return (
              <Link
                key={agent.id}
                to={`/agents/${agent.id}`}
                className={cn(
                  'glass glass-hover group flex flex-col rounded-2xl p-5 focus-ring',
                  isVozCore && 'border-[var(--accent)]/25',
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <span
                    className={cn(
                      'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border',
                      isVozCore
                        ? 'border-[var(--accent)]/35 bg-[var(--accent-faint)] text-[var(--accent)]'
                        : 'border-white/10 bg-white/5 text-mist-300',
                    )}
                  >
                    <Icon size={20} />
                  </span>
                  <StatusPill {...meta} pulse={agent.status === 'active'} />
                </div>

                <div className="mt-4 flex items-center gap-2">
                  <h2 className="text-[15px] font-semibold text-mist-100">{agent.name}</h2>
                  {isVozCore ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-gild-500/30 bg-gild-500/10 px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider text-gild-400">
                      <Sparkles size={9} /> Manager
                    </span>
                  ) : null}
                </div>
                <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-mist-400">{agent.description}</p>

                <div className="mt-4 flex flex-wrap gap-1.5">
                  {agent.responsibilities.slice(0, 2).map((item) => (
                    <span key={item} className="max-w-full truncate rounded-md bg-white/5 px-2 py-1 text-[10.5px] text-mist-400">
                      {item}
                    </span>
                  ))}
                  {agent.responsibilities.length > 2 ? (
                    <span className="rounded-md bg-white/5 px-2 py-1 text-[10.5px] text-mist-500">
                      +{agent.responsibilities.length - 2} more
                    </span>
                  ) : null}
                </div>

                <div className="mt-4 flex items-center justify-between border-t border-white/7 pt-3.5 text-[11px] text-mist-500">
                  <span>
                    <span className="font-semibold text-mist-300">{agent.taskCounts.open}</span> open
                    <span className="mx-1.5 text-mist-600">·</span>
                    <span className="font-semibold text-mist-300">{agent.taskCounts.completed}</span> done
                  </span>
                  <span className="flex items-center gap-2">
                    {formatRelative(agent.lastActiveAt)}
                    <ArrowUpRight size={13} className="text-mist-600 transition group-hover:text-[var(--accent)]" />
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
