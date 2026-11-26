import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  Brain,
  CheckCircle2,
  Gauge,
  ListTodo,
  MessageSquare,
  ShieldCheck,
  Workflow as WorkflowIcon,
} from 'lucide-react';
import { api } from '../lib/api';
import type { AnalyticsPayload } from '../lib/types';
import { useToast } from '../context/ToastContext';
import { errorMessage } from '../context/AuthContext';
import { PageHeader } from '../components/PageHeader';
import { StatCard } from '../components/StatCard';
import { AreaTrendChart, BarListChart, DonutChart } from '../components/charts/Charts';
import { EmptyState, Spinner } from '../components/ui/Feedback';
import { Chip } from '../components/ui/Badge';
import { TASK_STATUS_META, agentIcon } from '../lib/constants';
import { cn, percent } from '../lib/utils';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

const RANGES = [7, 14, 30, 90];

const STATUS_COLORS: Record<string, string> = {
  pending: '#8e8ea6',
  in_progress: '#60a5fa',
  waiting_approval: '#d9a94e',
  completed: '#34d399',
  failed: '#f87171',
};

const PRIORITY_COLORS: Record<string, string> = {
  low: '#6a6a82',
  medium: '#60a5fa',
  high: '#fbbf24',
  critical: '#f87171',
};

export function AnalyticsPage() {
  useDocumentTitle('Analytics · VozPilot');
  const toast = useToast();

  const [range, setRange] = useState(30);
  const [data, setData] = useState<AnalyticsPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    api
      .get<AnalyticsPayload>(`/api/analytics?range=${range}`)
      .then(setData)
      .catch((caught) => setLoadError(errorMessage(caught)));
  }, [range]);

  useEffect(() => {
    setData(null);
    load();
  }, [load]);

  if (loadError && !data) {
    return (
      <div className="anim-enter">
        <EmptyState
          title="Couldn't load analytics"
          description={loadError}
          action={<button type="button" onClick={load} className="focus-ring rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white">Retry</button>}
        />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-32">
        <Spinner size={24} />
        <p className="text-xs text-mist-500">Crunching real numbers…</p>
      </div>
    );
  }

  const hasTrend = data.completionTrend.some((point) => point.count > 0);
  const maxAssigned = Math.max(...data.agentActivity.map((agent) => agent.assigned), 1);

  return (
    <div className="anim-enter flex flex-col gap-6">
      <PageHeader
        title="Analytics"
        subtitle="Performance computed from your workspace — never simulated."
        actions={
          <div className="flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/4 p-1">
            {RANGES.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setRange(value)}
                className={cn(
                  'focus-ring rounded-lg px-3 py-1.5 text-xs font-medium transition',
                  range === value ? 'bg-[var(--accent)] text-white' : 'text-mist-400 hover:text-mist-200',
                )}
              >
                {value}d
              </button>
            ))}
          </div>
        }
      />

      {/* KPI row */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Completion rate"
          value={data.totals.completionRate === null ? '—' : percent(data.totals.completionRate)}
          icon={CheckCircle2}
          tone={data.totals.completionRate === null ? 'neutral' : 'success'}
          caption={data.totals.completionRate === null ? 'No finished tasks yet' : 'Completed vs failed tasks'}
        />
        <StatCard
          label="Avg. tasks / day"
          value={data.totals.avgTasksPerDay ?? '—'}
          icon={ListTodo}
          tone="violet"
          caption={`Across the last ${range} days`}
        />
        <StatCard label="Agents with work" value={data.agentActivity.filter((agent) => agent.assigned > 0).length} icon={Gauge} tone="gold" caption={`Of ${data.agentActivity.length} workforce profiles`} />
        <StatCard label="Activity events" value={data.totals.activityEvents} icon={Activity} tone="neutral" caption="Recorded workspace events" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Tasks" value={data.totals.tasks} icon={ListTodo} tone="violet" caption="All-time workspace tasks" />
        <StatCard label="Memories" value={data.totals.memories} icon={Brain} tone="gold" caption="Stored knowledge entries" />
        <StatCard label="Conversations" value={data.totals.conversations} icon={MessageSquare} tone="neutral" caption="Command center threads" />
        <StatCard label="Approvals resolved" value={data.totals.approvalsResolved} icon={ShieldCheck} tone="warning" caption="Approved or rejected decisions" />
      </div>

      {/* Trend */}
      <section className="glass rounded-2xl p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-mist-100">Completion trend</h2>
            <p className="mt-0.5 text-xs text-mist-500">Tasks completed per day · last {range} days</p>
          </div>
          <span className="font-mono text-xs text-mist-500">
            {data.completionTrend.reduce((sum, point) => sum + point.count, 0)} completed in range
          </span>
        </div>
        {hasTrend ? (
          <AreaTrendChart data={data.completionTrend} />
        ) : (
          <EmptyState
            compact
            title="No completions in this range"
            description="Widen the range or complete tasks to populate the trend."
          />
        )}
      </section>

      {/* Distributions */}
      <div className="grid gap-4 xl:grid-cols-2">
        <section className="glass rounded-2xl p-5">
          <div className="mb-3">
            <h2 className="text-sm font-semibold text-mist-100">Task status distribution</h2>
            <p className="mt-0.5 text-xs text-mist-500">Where your queue stands right now</p>
          </div>
          <DonutChart
            data={data.statusDistribution.map((entry) => ({
              label: TASK_STATUS_META[entry.status as keyof typeof TASK_STATUS_META]?.label ?? entry.status,
              value: entry.count,
              color: STATUS_COLORS[entry.status],
            }))}
          />
        </section>

        <section className="glass rounded-2xl p-5">
          <div className="mb-4">
            <h2 className="text-sm font-semibold text-mist-100">Priority mix</h2>
            <p className="mt-0.5 text-xs text-mist-500">How work is weighted across priorities</p>
          </div>
          <BarListChart
            data={data.priorityDistribution
              .slice()
              .sort((a, b) => b.count - a.count)
              .map((entry) => ({
                label: entry.priority.charAt(0).toUpperCase() + entry.priority.slice(1),
                value: entry.count,
              }))}
            emptyLabel="No tasks to distribute yet."
          />
        </section>
      </div>

      {/* Agent activity */}
      <section className="glass rounded-2xl p-5">
        <div className="mb-4">
          <h2 className="text-sm font-semibold text-mist-100">Agent activity</h2>
          <p className="mt-0.5 text-xs text-mist-500">Assigned vs completed tasks and logged events</p>
        </div>
        {data.totals.tasks === 0 ? (
          <EmptyState compact icon={<Activity size={18} />} title="No agent activity yet" description="Assign tasks to agents to see their workload here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead>
                <tr className="border-b border-white/8 text-[11px] uppercase tracking-[0.1em] text-mist-500">
                  <th className="py-2.5 pr-4 font-semibold">Agent</th>
                  <th className="px-4 py-2.5 font-semibold">Workload</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Assigned</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Completed</th>
                  <th className="py-2.5 pl-4 text-right font-semibold">Events ({range}d)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/6">
                {data.agentActivity.map((agent) => {
                  const Icon = agentIcon(agent.icon);
                  const assignedWidth = (agent.assigned / maxAssigned) * 100;
                  const completedWidth = agent.assigned > 0 ? (agent.completed / agent.assigned) * 100 : 0;
                  return (
                    <tr key={agent.agentId}>
                      <td className="py-3 pr-4">
                        <span className="inline-flex items-center gap-2.5 text-xs font-medium text-mist-200">
                          <span className="flex h-7 w-7 items-center justify-center rounded-md border border-white/10 bg-white/5 text-[var(--accent)]">
                            <Icon size={13} />
                          </span>
                          {agent.name}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="h-2 w-full min-w-32 overflow-hidden rounded-full bg-white/6">
                          <div className="relative h-full">
                            <div
                              className="absolute inset-y-0 left-0 rounded-full bg-white/25"
                              style={{ width: `${assignedWidth}%` }}
                            />
                            <div
                              className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-[var(--accent-strong)] to-[var(--accent)]"
                              style={{ width: `${(agent.completed / maxAssigned) * 100}%` }}
                            />
                          </div>
                        </div>
                        <p className="mt-1 text-[10px] text-mist-600">
                          {agent.assigned > 0 ? `${Math.round(completedWidth)}% of assigned completed` : 'No assignments'}
                        </p>
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-mist-300">{agent.assigned}</td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-verdant-400">{agent.completed}</td>
                      <td className="py-3 pl-4 text-right font-mono text-xs text-mist-400">{agent.events}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Workflow stats */}
      <section className="glass rounded-2xl p-5">
        <div className="mb-4 flex items-center gap-2">
          <WorkflowIcon size={15} className="text-gild-400" />
          <div>
            <h2 className="text-sm font-semibold text-mist-100">Workflow statistics</h2>
            <p className="mt-0.5 text-xs text-mist-500">Definition status across your workflows</p>
          </div>
        </div>
        {data.workflowStats.total === 0 ? (
          <EmptyState compact title="No workflows yet" description="Create workflows to see their status breakdown here." />
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(
              [
                ['Total', data.workflowStats.total],
                ['Active', data.workflowStats.active],
                ['Draft', data.workflowStats.draft],
                ['Paused', data.workflowStats.paused],
              ] as [string, number][]
            ).map(([label, value]) => (
              <div key={label} className="rounded-xl border border-white/8 bg-white/3 px-4 py-3.5">
                <p className="micro-label">{label}</p>
                <p className="mt-1.5 text-xl font-semibold text-mist-100">{value}</p>
              </div>
            ))}
          </div>
        )}
        <p className="mt-3 text-[11px] text-mist-600">
          Execution counts stay at zero until the Phase 2 runtime — runs are never fabricated.
        </p>
      </section>

      {/* Range note */}
      <div className="flex justify-end">
        <Chip>Showing the last {range} days</Chip>
      </div>
    </div>
  );
}
