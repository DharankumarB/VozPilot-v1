import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  BarChart3,
  Bot,
  CalendarClock,
  CheckCircle2,
  Inbox,
  ListTodo,
  Send,
  ShieldCheck,
  Sparkles,
  TrendingUp,
} from 'lucide-react';
import { api } from '../lib/api';
import type { OverviewPayload } from '../lib/types';
import { useAuth } from '../context/AuthContext';
import { StatCard } from '../components/StatCard';
import { AreaTrendChart, BarListChart } from '../components/charts/Charts';
import { EmptyState, ListSkeleton } from '../components/ui/Feedback';
import { PageHeader } from '../components/PageHeader';
import { StatusPill, Chip } from '../components/ui/Badge';
import { AGENT_STATUS_META, TASK_STATUS_META, PRIORITY_META, ACTIVITY_CATEGORY_META } from '../lib/constants';
import { agentIcon } from '../lib/constants';
import { cn, formatDueDate, formatRelative } from '../lib/utils';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export function OverviewPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  useDocumentTitle('Overview · VozPilot');

  const [data, setData] = useState<OverviewPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [command, setCommand] = useState('');

  const load = useCallback(() => {
    setError(null);
    api
      .get<OverviewPayload>('/api/analytics/overview')
      .then(setData)
      .catch((caught) => setError(caught instanceof Error ? caught.message : 'Failed to load overview.'));
  }, []);

  useEffect(load, [load]);

  const submitCommand = (event: React.FormEvent) => {
    event.preventDefault();
    const draft = command.trim();
    if (!draft) return;
    navigate(`/command-center?draft=${encodeURIComponent(draft)}`);
  };

  if (error && !data) {
    return (
      <div className="flex flex-col items-center justify-center py-24">
        <EmptyState
          title="Couldn't load your overview"
          description={error}
          action={
            <button type="button" onClick={load} className="focus-ring rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white">
              Retry
            </button>
          }
        />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-col gap-6">
        <div>
          <div className="h-7 w-64 anim-shimmer rounded-lg bg-white/5" />
          <div className="mt-2 h-4 w-80 anim-shimmer rounded bg-white/5" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="panel h-32 anim-shimmer" />
          ))}
        </div>
        <div className="grid gap-4 xl:grid-cols-2">
          <div className="panel h-72 anim-shimmer" />
          <div className="panel h-72 anim-shimmer" />
        </div>
      </div>
    );
  }

  const stats = data.stats;
  const hasTasks = stats.tasksTotal > 0;
  const hasCompletions = data.completionSeries.some((point) => point.count > 0);
  const topAgents = data.agentPerformance.filter((agent) => agent.completed > 0);
  const today = new Date();

  return (
    <div className="anim-enter flex flex-col gap-6">
      <PageHeader
        title={`${greeting()}, ${user?.name?.split(' ')[0] ?? 'there'}`}
        subtitle={today.toLocaleDateString(undefined, {
          weekday: 'long',
          month: 'long',
          day: 'numeric',
          year: 'numeric',
        })}
        actions={
          <Link
            to="/agents"
            className="focus-ring inline-flex h-9 items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3.5 text-xs font-medium text-mist-300 transition hover:bg-white/9 hover:text-mist-100"
          >
            <Bot size={14} className="text-[var(--accent)]" />
            Manage workforce
          </Link>
        }
      />

      {/* Quick command */}
      <form onSubmit={submitCommand} className="glass rounded-2xl p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[var(--accent)]/30 bg-[var(--accent-faint)] text-[var(--accent)]">
            <Sparkles size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <input
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              placeholder="Quick command for VozCore… e.g. “Summarise this week's project risks”"
              aria-label="Quick command"
              className="focus-ring w-full bg-transparent text-sm text-mist-100 placeholder:text-mist-500 focus:outline-none"
            />
          </div>
          <button
            type="submit"
            disabled={!command.trim()}
            className="focus-ring inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-xl bg-[var(--accent)] px-4 text-sm font-medium text-white transition hover:bg-[var(--accent-strong)] disabled:pointer-events-none disabled:opacity-40"
          >
            <Send size={14} />
            Open Command Center
          </button>
        </div>
        <p className="mt-2.5 text-[11px] text-mist-600">
          Commands open as drafts in the AI Command Center — VozCore orchestration connects in Phase 2.
        </p>
      </form>

      {/* Stat cards */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        <StatCard label="Total AI Agents" value={stats.totalAgents} icon={Bot} tone="violet" caption="Profiles in your workforce" />
        <StatCard label="Active Agents" value={stats.activeAgents} icon={Sparkles} tone="success" caption="Currently marked active" />
        <StatCard label="Tasks Completed" value={stats.tasksCompleted} icon={CheckCircle2} tone="success" caption={hasTasks ? `${stats.tasksTotal} tasks total` : 'No tasks yet'} />
        <StatCard label="Pending Tasks" value={stats.tasksPending} icon={Inbox} tone="neutral" caption={`${stats.tasksInProgress} in progress`} />
        <StatCard label="Pending Approvals" value={stats.pendingApprovals} icon={ShieldCheck} tone={stats.pendingApprovals > 0 ? 'warning' : 'neutral'} caption={stats.pendingApprovals > 0 ? 'Waiting for your decision' : 'All caught up'} />
        <StatCard
          label="Automation Success"
          value={stats.automationSuccessRate === null ? '—' : `${stats.automationSuccessRate}%`}
          icon={TrendingUp}
          tone={stats.automationSuccessRate === null ? 'neutral' : stats.automationSuccessRate >= 80 ? 'success' : 'warning'}
          caption={
            stats.automationSuccessRate === null
              ? 'No finished tasks yet'
              : `${stats.tasksCompleted} completed vs ${stats.tasksFailed} failed`
          }
        />
      </div>

      {/* Charts row */}
      <div className="grid gap-4 xl:grid-cols-5">
        <section className="glass rounded-2xl p-5 xl:col-span-3">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-mist-100">Task completion</h2>
              <p className="mt-0.5 text-xs text-mist-500">Completed tasks over the last 14 days</p>
            </div>
            <Link to="/analytics" className="focus-ring rounded-lg text-xs font-medium text-[var(--accent)] hover:underline">
              Analytics
            </Link>
          </div>
          {hasCompletions ? (
            <AreaTrendChart data={data.completionSeries} />
          ) : (
            <EmptyState
              compact
              icon={<BarChart3 size={18} />}
              title="No completions yet"
              description="Completed tasks will chart here as soon as work moves to Completed."
            />
          )}
        </section>

        <section className="glass rounded-2xl p-5 xl:col-span-2">
          <div className="mb-4">
            <h2 className="text-sm font-semibold text-mist-100">Agent performance</h2>
            <p className="mt-0.5 text-xs text-mist-500">Completed tasks per agent</p>
          </div>
          {topAgents.length > 0 ? (
            <BarListChart
              data={data.agentPerformance.map((agent) => ({
                label: agent.name,
                value: agent.completed,
                sublabel: `${agent.open} open · ${agent.total} assigned`,
              }))}
              emptyLabel="No completed tasks yet."
            />
          ) : (
            <EmptyState
              compact
              icon={<Bot size={18} />}
              title="No performance data"
              description="Assign tasks to agents and complete them to populate this chart."
              action={
                <Link to="/tasks" className="focus-ring rounded-lg border border-white/12 px-3.5 py-1.5 text-xs font-medium text-mist-300 hover:bg-white/6">
                  Open Task Manager
                </Link>
              }
            />
          )}
        </section>
      </div>

      {/* Workforce + activity row */}
      <div className="grid gap-4 xl:grid-cols-2">
        <section className="glass rounded-2xl p-5">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-mist-100">Agent workforce</h2>
              <p className="mt-0.5 text-xs text-mist-500">
                {stats.activeAgents} active · {stats.totalAgents} total
              </p>
            </div>
            <Link to="/agents" className="focus-ring inline-flex items-center gap-1 rounded-lg text-xs font-medium text-[var(--accent)] hover:underline">
              Agent Hub <ArrowRight size={12} />
            </Link>
          </div>
          {data.agents.length === 0 ? (
            <EmptyState compact title="No agents" description="Agent profiles appear here once your workspace is seeded." />
          ) : (
            <ul className="flex flex-col divide-y divide-white/6">
              {data.agents.slice(0, 6).map((agent) => {
                const Icon = agentIcon(agent.icon);
                const meta = AGENT_STATUS_META[agent.status];
                return (
                  <li key={agent.id}>
                    <Link
                      to={`/agents/${agent.id}`}
                      className="focus-ring flex items-center gap-3 rounded-lg px-1 py-2.5 transition hover:bg-white/4"
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-[var(--accent)]">
                        <Icon size={16} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-mist-200">{agent.name}</span>
                        <span className="block text-[11px] text-mist-500">
                          Last active {formatRelative(agent.lastActiveAt)}
                        </span>
                      </span>
                      <StatusPill {...meta} pulse={agent.status === 'active'} />
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="glass rounded-2xl p-5">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-mist-100">Recent activity</h2>
              <p className="mt-0.5 text-xs text-mist-500">Real events from your workspace</p>
            </div>
            <Link to="/activity" className="focus-ring inline-flex items-center gap-1 rounded-lg text-xs font-medium text-[var(--accent)] hover:underline">
              Activity Center <ArrowRight size={12} />
            </Link>
          </div>
          {data.recentActivity.length === 0 ? (
            <EmptyState
              compact
              title="No activity yet"
              description="Events like task creation and approvals will stream here."
            />
          ) : (
            <ul className="flex flex-col gap-3">
              {data.recentActivity.slice(0, 7).map((item) => {
                const meta = ACTIVITY_CATEGORY_META[item.category] ?? ACTIVITY_CATEGORY_META.system;
                const Icon = meta.icon;
                return (
                  <li key={item.id} className="flex items-start gap-3">
                    <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/4 text-mist-400">
                      <Icon size={13} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium text-mist-200">{item.title}</p>
                      <p className="mt-0.5 text-[11px] text-mist-500">
                        {formatRelative(item.createdAt)}
                        {item.detail ? ` · ${item.detail}` : ''}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      {/* Recent tasks + upcoming */}
      <div className="grid gap-4 xl:grid-cols-2">
        <section className="glass rounded-2xl p-5">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-mist-100">Recent tasks</h2>
              <p className="mt-0.5 text-xs text-mist-500">Latest changes across your workspace</p>
            </div>
            <Link to="/tasks" className="focus-ring inline-flex items-center gap-1 rounded-lg text-xs font-medium text-[var(--accent)] hover:underline">
              Task Manager <ArrowRight size={12} />
            </Link>
          </div>
          {data.recentTasks.length === 0 ? (
            <EmptyState
              compact
              icon={<ListTodo size={18} />}
              title="No tasks yet"
              description="Create your first task to start tracking work."
              action={
                <Link to="/tasks" className="focus-ring rounded-lg bg-[var(--accent)] px-3.5 py-1.5 text-xs font-medium text-white">
                  Create a task
                </Link>
              }
            />
          ) : (
            <ul className="flex flex-col divide-y divide-white/6">
              {data.recentTasks.map((task) => (
                <li key={task.id} className="flex items-center gap-3 py-2.5">
                  <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', PRIORITY_META[task.priority]?.dot ?? 'bg-mist-400')} />
                  <span className="min-w-0 flex-1 truncate text-sm text-mist-200">{task.title}</span>
                  <span className="hidden shrink-0 text-[11px] text-mist-500 sm:block">
                    {task.agentName ?? 'Unassigned'}
                  </span>
                  <StatusPill {...TASK_STATUS_META[task.status]} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="glass rounded-2xl p-5">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-mist-100">Upcoming scheduled</h2>
              <p className="mt-0.5 text-xs text-mist-500">Open tasks with upcoming due dates</p>
            </div>
            <Link to="/tasks?sort=due_asc" className="focus-ring inline-flex items-center gap-1 rounded-lg text-xs font-medium text-[var(--accent)] hover:underline">
              View all <ArrowRight size={12} />
            </Link>
          </div>
          {data.upcoming.length === 0 ? (
            <EmptyState
              compact
              icon={<CalendarClock size={18} />}
              title="Nothing scheduled"
              description="Open tasks with due dates will appear here in date order."
            />
          ) : (
            <ul className="flex flex-col divide-y divide-white/6">
              {data.upcoming.map((task) => {
                const due = formatDueDate(task.dueDate);
                return (
                  <li key={task.id} className="flex items-center gap-3 py-2.5">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/4 text-mist-400">
                      <CalendarClock size={14} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-mist-200">{task.title}</span>
                      <span className="block text-[11px] text-mist-500">{task.agentName ?? 'Unassigned'}</span>
                    </span>
                    <Chip
                      className={cn(
                        due.tone === 'overdue' && 'border-rosh-500/40 bg-rosh-500/10 text-rosh-400',
                        due.tone === 'today' && 'border-gild-500/40 bg-gild-500/10 text-gild-400',
                      )}
                      title={task.dueDate ?? undefined}
                    >
                      {due.label}
                    </Chip>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
