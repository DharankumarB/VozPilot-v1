import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Bot,
  Coins,
  Cpu,
  PauseCircle,
  PlayCircle,
  RefreshCw,
  Search,
  Sparkles,
  Zap,
} from 'lucide-react';
import { api } from '../lib/api';
import type { Agent, AgentStatus } from '../lib/types';
import { vozcore, type MonitoringSummary } from '../lib/vozcore';
import { useToast } from '../context/ToastContext';
import { errorMessage } from '../context/AuthContext';
import { PageHeader } from '../components/PageHeader';
import { Button } from '../components/ui/Button';
import { StatusPill, Chip, Badge } from '../components/ui/Badge';
import { EmptyState, ListSkeleton } from '../components/ui/Feedback';
import { WORKSPACE_PAUSE_EVENT } from '../hooks/useWorkspacePulse';
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
  const [monitoring, setMonitoring] = useState<MonitoringSummary | null>(null);
  const [filter, setFilter] = useState<AgentStatus | 'all'>('all');
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [busyAgentId, setBusyAgentId] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    api
      .get<Agent[]>('/api/agents')
      .then(setAgents)
      .catch((caught) => setError(errorMessage(caught)));
    vozcore
      .monitoring()
      .then(setMonitoring)
      .catch(() => setMonitoring(null));
  }, []);

  useEffect(() => {
    load();
    const onPauseChanged = () => load();
    window.addEventListener(WORKSPACE_PAUSE_EVENT, onPauseChanged);
    return () => window.removeEventListener(WORKSPACE_PAUSE_EVENT, onPauseChanged);
  }, [load]);

  const toggleGlobalPause = async () => {
    setPauseBusy(true);
    try {
      if (monitoring?.agentsPaused) {
        await vozcore.resumeAll();
        toast.success('All agents resumed', 'Workforce is ready to accept VozCore delegations.');
      } else {
        await vozcore.pauseAll();
        toast.info('All agents paused', 'In-flight dispatches halted and new work blocked.');
      }
      window.dispatchEvent(new Event(WORKSPACE_PAUSE_EVENT));
      load();
    } catch (caught) {
      toast.error('Could not update workforce pause state', errorMessage(caught));
    } finally {
      setPauseBusy(false);
    }
  };

  const quickToggleAgentPause = async (agent: Agent, event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const nextStatus: AgentStatus = agent.status === 'paused' ? 'idle' : 'paused';
    setBusyAgentId(agent.id);
    try {
      await api.patch<Agent>(`/api/agents/${agent.id}`, { status: nextStatus });
      toast.success(
        nextStatus === 'paused' ? `${agent.name} paused` : `${agent.name} resumed`,
        nextStatus === 'paused'
          ? 'VozCore will not assign subtasks to this agent until resumed.'
          : 'Ready to accept delegated subtasks.',
      );
      window.dispatchEvent(new Event(WORKSPACE_PAUSE_EVENT));
      load();
    } catch (caught) {
      toast.error('Could not update agent status', errorMessage(caught));
    } finally {
      setBusyAgentId(null);
    }
  };

  const visible = useMemo(() => {
    if (!agents) return [];
    const term = search.trim().toLowerCase();
    return agents.filter((agent) => {
      if (filter !== 'all' && agent.status !== filter) return false;
      if (term && !`${agent.name} ${agent.description} ${agent.key}`.toLowerCase().includes(term)) return false;
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
        subtitle="VozCore manager + eight autonomous specialist agents — real database telemetry, permissions, tool gates, and live agent testing."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-mist-500" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search agents…"
                aria-label="Search agents"
                className="focus-ring h-9 w-52 rounded-xl border border-white/10 bg-white/4 pl-9 pr-3 text-sm text-mist-100 placeholder:text-mist-500 focus:border-[var(--accent)]"
              />
            </div>
            <Button variant="secondary" size="sm" icon={<RefreshCw size={13} />} onClick={load}>
              Refresh
            </Button>
            <Button
              variant={monitoring?.agentsPaused ? 'primary' : 'danger'}
              size="sm"
              loading={pauseBusy}
              icon={monitoring?.agentsPaused ? <PlayCircle size={13} /> : <PauseCircle size={13} />}
              onClick={() => void toggleGlobalPause()}
            >
              {monitoring?.agentsPaused ? 'Resume All Agents' : 'Pause All Agents'}
            </Button>
          </div>
        }
      />

      {/* Global pause banner */}
      {monitoring?.agentsPaused ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-gild-400/35 bg-gild-500/10 px-4 py-3">
          <div className="flex items-center gap-2.5 text-xs text-gild-300">
            <AlertTriangle size={15} className="shrink-0 text-gild-400" />
            <span>
              <strong className="font-semibold">Emergency Pause Active:</strong> All autonomous agent dispatches and Test Agent runs are blocked until you resume the workforce.
            </span>
          </div>
          <Button size="sm" variant="primary" loading={pauseBusy} onClick={() => void toggleGlobalPause()}>
            Resume Workforce
          </Button>
        </div>
      ) : null}

      {/* Live Workforce Telemetry Bar (zero fabricated stats — straight from PostgreSQL) */}
      {monitoring ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="glass rounded-2xl p-4">
            <div className="flex items-center justify-between text-xs text-mist-500">
              <span>Engine Health</span>
              <Cpu size={14} className="text-[var(--accent)]" />
            </div>
            <p className="mt-2 text-base font-semibold text-mist-100">
              {monitoring.llmConfigured ? `Online · ${monitoring.model ?? monitoring.llmMode}` : 'Engine Ready · LLM Unconfigured'}
            </p>
            <p className="mt-1 text-[11px] text-mist-500">
              {monitoring.agents.filter((a) => a.operational).length} of {monitoring.agents.length} specialists operational
            </p>
          </div>

          <div className="glass rounded-2xl p-4">
            <div className="flex items-center justify-between text-xs text-mist-500">
              <span>Live Execution Load</span>
              <Activity size={14} className="text-verdant-400" />
            </div>
            <p className="mt-2 text-base font-semibold text-mist-100">
              {monitoring.tasks.running} running · {monitoring.executions.completed} runs done
            </p>
            <p className="mt-1 text-[11px] text-mist-500">
              {monitoring.tasks.failed} failed subtasks · {monitoring.tasks.retried} retried
            </p>
          </div>

          <div className="glass rounded-2xl p-4">
            <div className="flex items-center justify-between text-xs text-mist-500">
              <span>Token Consumption</span>
              <Zap size={14} className="text-azure-400" />
            </div>
            <p className="mt-2 font-mono text-base font-semibold text-mist-100">
              {monitoring.usage.totalTokens.toLocaleString()} tokens
            </p>
            <p className="mt-1 text-[11px] text-mist-500">
              {monitoring.usage.calls} model calls
              {monitoring.usage.avgDurationMs !== null ? ` · avg ${Math.round(monitoring.usage.avgDurationMs)}ms` : ''}
            </p>
          </div>

          <div className="glass rounded-2xl p-4">
            <div className="flex items-center justify-between text-xs text-mist-500">
              <span>Estimated Model Cost</span>
              <Coins size={14} className="text-gild-400" />
            </div>
            <p className="mt-2 font-mono text-base font-semibold text-mist-100">
              {monitoring.usage.estimatedCostUsd !== null
                ? `$${monitoring.usage.estimatedCostUsd.toFixed(4)}`
                : monitoring.pricingConfigured
                  ? '$0.0000'
                  : 'Not configured'}
            </p>
            <p className="mt-1 text-[11px] text-mist-500">
              {monitoring.pricingConfigured
                ? 'Calculated from configured per-1M token rates'
                : 'Set MODEL_INPUT/OUTPUT_COST_PER_1M_USD in .env'}
            </p>
          </div>
        </div>
      ) : null}

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
        <EmptyState
          title="Couldn't load agents"
          description={error}
          action={
            <button
              type="button"
              onClick={load}
              className="focus-ring rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white"
            >
              Retry
            </button>
          }
        />
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
            const isEnabled = agent.enabled !== false;
            const completedCount =
              agent.taskCounts.completed + (agent.agentTaskCounts?.completed ?? 0);
            const runningCount = agent.agentTaskCounts?.running ?? 0;

            return (
              <Link
                key={agent.id}
                to={`/agents/${agent.id}`}
                className={cn(
                  'glass glass-hover group flex flex-col rounded-2xl p-5 focus-ring',
                  isVozCore && 'border-[var(--accent)]/25',
                  !isEnabled && 'opacity-70',
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
                  <div className="flex items-center gap-1.5">
                    {!isEnabled ? (
                      <Badge className="border border-white/12 bg-white/5 text-mist-500">Disabled</Badge>
                    ) : null}
                    <StatusPill {...meta} pulse={agent.status === 'active' || runningCount > 0} />
                  </div>
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

                {/* Live Current Task slot */}
                <div className="mt-3 rounded-xl border border-white/8 bg-black/25 px-3 py-2 text-[11px]">
                  <span className="text-mist-600">Current task: </span>
                  {agent.currentTask ? (
                    <span className="font-medium text-[var(--accent)]">{agent.currentTask.title}</span>
                  ) : (
                    <span className="text-mist-500">
                      {agent.status === 'paused' || !isEnabled ? 'Not accepting delegations' : 'Idle — awaiting delegation'}
                    </span>
                  )}
                </div>

                <div className="mt-3 flex flex-wrap gap-1.5">
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

                <div className="mt-auto pt-4">
                  <div className="flex items-center justify-between border-t border-white/7 pt-3.5 text-[11px] text-mist-500">
                    <span>
                      <span className="font-semibold text-mist-200">{completedCount}</span> completed
                      <span className="mx-1.5 text-mist-600">·</span>
                      <span className="font-semibold text-mist-300">{agent.taskCounts.open}</span> open
                    </span>
                    <div className="flex items-center gap-2">
                      {!isVozCore ? (
                        <button
                          type="button"
                          disabled={busyAgentId === agent.id}
                          onClick={(event) => void quickToggleAgentPause(agent, event)}
                          title={agent.status === 'paused' ? `Resume ${agent.name}` : `Pause ${agent.name}`}
                          className="focus-ring rounded-md border border-white/10 bg-white/4 px-2 py-0.5 text-[10.5px] font-medium text-mist-300 transition hover:border-white/25 hover:text-mist-100"
                        >
                          {agent.status === 'paused' ? 'Resume' : 'Pause'}
                        </button>
                      ) : null}
                      <span>{formatRelative(agent.lastActiveAt)}</span>
                      <ArrowUpRight size={13} className="text-mist-600 transition group-hover:text-[var(--accent)]" />
                    </div>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
