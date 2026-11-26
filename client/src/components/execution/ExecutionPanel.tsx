import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  Clock3,
  ExternalLink,
  GitBranch,
  Loader2,
  MessageSquareShare,
  PauseCircle,
  XCircle,
  Zap,
} from 'lucide-react';
import {
  EVENT_LABELS,
  STEP_LABELS,
  TIMELINE_EVENTS,
  isLiveStatus,
  type ExecutionDetail,
  type ExecutionStatus,
  type ExecutionTask,
} from '../../lib/vozcore';
import { cn, formatDateTime, formatRelative } from '../../lib/utils';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';

/** Status presentation for the six execution states — visually distinct. */
export const EXECUTION_STATUS_META: Record<
  ExecutionStatus,
  { label: string; dot: string; text: string; border: string; bg: string }
> = {
  planning: { label: 'Planning', dot: 'bg-azure-400', text: 'text-azure-400', border: 'border-azure-400/35', bg: 'bg-azure-400/10' },
  running: { label: 'Running', dot: 'bg-[var(--accent)]', text: 'text-[var(--accent)]', border: 'border-[var(--accent)]/40', bg: 'bg-[var(--accent-soft)]' },
  waiting: { label: 'Waiting', dot: 'bg-gild-400', text: 'text-gild-300', border: 'border-gild-400/35', bg: 'bg-gild-400/10' },
  completed: { label: 'Completed', dot: 'bg-verdant-400', text: 'text-verdant-400', border: 'border-verdant-400/35', bg: 'bg-verdant-400/10' },
  failed: { label: 'Failed', dot: 'bg-rosh-400', text: 'text-rosh-400', border: 'border-rosh-400/35', bg: 'bg-rosh-400/10' },
  cancelled: { label: 'Cancelled', dot: 'bg-mist-500', text: 'text-mist-400', border: 'border-white/15', bg: 'bg-white/5' },
};

const TASK_STATUS_META: Record<ExecutionTask['status'], { label: string; className: string }> = {
  pending: { label: 'Pending', className: 'text-mist-400' },
  running: { label: 'Running', className: 'text-[var(--accent)]' },
  waiting: { label: 'Waiting Approval', className: 'text-gild-400' },
  completed: { label: 'Completed', className: 'text-verdant-400' },
  failed: { label: 'Failed', className: 'text-rosh-400' },
  cancelled: { label: 'Cancelled', className: 'text-mist-500' },
};

function TaskStatusDot({ status }: { status: ExecutionTask['status'] }) {
  const meta = TASK_STATUS_META[status];
  return (
    <span className="flex items-center gap-1.5 text-[11px] font-medium">
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          status === 'completed' && 'bg-verdant-400',
          status === 'running' && 'animate-pulse bg-[var(--accent)]',
          status === 'failed' && 'bg-rosh-400',
          status === 'waiting' && 'bg-gild-400',
          status === 'pending' && 'bg-mist-600',
          status === 'cancelled' && 'bg-mist-600',
        )}
      />
      <span className={meta.className}>{meta.label}</span>
    </span>
  );
}

interface ExecutionPanelProps {
  detail: ExecutionDetail;
  onCancel: (executionId: string) => void;
  cancelling?: boolean;
}

/**
 * Live execution view: plan preview, agent assignment, wave/dependency
 * layout, node progress, inter-agent messages, event timeline, structured
 * artifacts/citations, and final response.
 */
export function ExecutionPanel({ detail, onCancel, cancelling = false }: ExecutionPanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [showDeps, setShowDeps] = useState(false);
  const execution = detail.execution;
  const meta = EXECUTION_STATUS_META[execution.status];
  const live = isLiveStatus(execution.status);

  const waves = useMemo(() => {
    const byWave = new Map<number, ExecutionTask[]>();
    for (const task of detail.tasks) {
      const list = byWave.get(task.wave) ?? [];
      list.push(task);
      byWave.set(task.wave, list);
    }
    return [...byWave.entries()].sort((a, b) => a[0] - b[0]);
  }, [detail.tasks]);

  const timeline = useMemo(
    () => detail.events.filter((event) => TIMELINE_EVENTS.has(event.type)),
    [detail.events],
  );

  const agentByKey = useMemo(() => {
    const map = new Map<string, string>();
    if (execution.plan) for (const task of execution.plan.tasks) map.set(task.task_key, task.agent_key);
    for (const task of detail.tasks) map.set(task.task_key, task.agent_key);
    return map;
  }, [execution.plan, detail.tasks]);

  const duration = (() => {
    if (!execution.startedAt) return null;
    const end = execution.finishedAt ? new Date(execution.finishedAt).getTime() : Date.now();
    const seconds = Math.max(0, Math.round((end - new Date(execution.startedAt).getTime()) / 1000));
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  })();

  return (
    <div className="overflow-hidden rounded-2xl border border-white/10 bg-void-900/70">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/8 px-4 py-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2.5">
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium',
              meta.border,
              meta.bg,
              meta.text,
            )}
          >
            <span className={cn('h-1.5 w-1.5 rounded-full', meta.dot, live && 'animate-pulse')} />
            {meta.label}
          </span>
          <span className="truncate text-xs text-mist-400" title={execution.command}>
            {execution.command.length > 72 ? `${execution.command.slice(0, 72)}…` : execution.command}
          </span>
          {duration ? (
            <span className="inline-flex items-center gap-1 text-[11px] text-mist-600">
              <Clock3 size={11} />
              {duration}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {live || execution.status === 'waiting' ? (
            <Button
              size="sm"
              variant="ghost"
              icon={cancelling ? <Loader2 size={13} className="animate-spin" /> : <CircleSlash size={13} />}
              onClick={() => onCancel(execution.id)}
              disabled={cancelling || execution.cancelRequested}
              className="text-rosh-400 hover:text-rosh-400"
            >
              {execution.cancelRequested ? 'Cancelling…' : 'Cancel'}
            </Button>
          ) : null}
          <button
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            className="focus-ring rounded-lg p-1.5 text-mist-500 transition hover:bg-white/6 hover:text-mist-300"
            aria-label={collapsed ? 'Expand run details' : 'Collapse run details'}
          >
            {collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
          </button>
        </div>
      </div>

      {collapsed ? null : (
        <div className="flex flex-col gap-4 px-4 py-4">
          {/* Failure / clarification notices */}
          {execution.status === 'failed' && execution.error ? (
            <div className="flex items-start gap-2.5 rounded-xl border border-rosh-500/30 bg-rosh-500/8 px-3.5 py-3">
              <XCircle size={15} className="mt-0.5 shrink-0 text-rosh-400" />
              <div>
                <p className="text-xs font-semibold text-rosh-400">Execution failed</p>
                <p className="mt-1 break-words text-xs leading-relaxed text-mist-400">{execution.error}</p>
              </div>
            </div>
          ) : null}
          {execution.status === 'waiting' && execution.clarification ? (
            <div className="flex items-start gap-2.5 rounded-xl border border-gild-500/30 bg-gild-500/8 px-3.5 py-3">
              <AlertTriangle size={15} className="mt-0.5 shrink-0 text-gild-400" />
              <div>
                <p className="text-xs font-semibold text-gild-300">VozCore needs more detail</p>
                <p className="mt-1 text-xs leading-relaxed text-mist-300">{execution.clarification}</p>
              </div>
            </div>
          ) : null}

          {/* Plan + selected agents */}
          {execution.plan ? (
            <section>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="micro-label">Execution plan</p>
                  <p className="mt-1 text-sm leading-relaxed text-mist-200">{execution.plan.summary}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowDeps((value) => !value)}
                  className="focus-ring inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-[11px] text-mist-400 transition hover:border-white/20 hover:text-mist-200"
                >
                  <GitBranch size={12} />
                  {showDeps ? 'Hide dependencies' : 'Show dependencies'}
                </button>
              </div>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {detail.tasks.length > 0 ? (
                  [...new Set(detail.tasks.map((task) => task.agent_key))].map((key) => (
                    <span
                      key={key}
                      className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/4 px-2.5 py-1 text-[11px] text-mist-300"
                    >
                      <Bot size={11} className="text-[var(--accent)]" />
                      {key}
                    </span>
                  ))
                ) : (
                  <span className="text-[11px] text-mist-500">No agents dispatched yet.</span>
                )}
              </div>
            </section>
          ) : null}

          {/* Node progress strip */}
          {detail.steps.length > 0 ? (
            <section>
              <p className="micro-label">Workflow progress</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {detail.steps.map((step) => (
                  <span
                    key={`${step.stepKey}-${step.seq}`}
                    title={step.error ?? STEP_LABELS[step.stepKey] ?? step.stepKey}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[10.5px]',
                      step.status === 'completed' && 'border-verdant-500/25 bg-verdant-500/8 text-verdant-400',
                      step.status === 'running' && 'border-[var(--accent)]/40 bg-[var(--accent-soft)] text-[var(--accent)]',
                      step.status === 'failed' && 'border-rosh-500/30 bg-rosh-500/8 text-rosh-400',
                      step.status === 'skipped' && 'border-white/8 bg-white/3 text-mist-600',
                    )}
                  >
                    {step.status === 'running' ? (
                      <Loader2 size={10} className="animate-spin" />
                    ) : step.status === 'completed' ? (
                      <CheckCircle2 size={10} />
                    ) : step.status === 'failed' ? (
                      <XCircle size={10} />
                    ) : (
                      <PauseCircle size={10} />
                    )}
                    {STEP_LABELS[step.stepKey] ?? step.stepKey}
                  </span>
                ))}
              </div>
            </section>
          ) : null}

          {/* Tasks by wave */}
          {waves.length > 0 ? (
            <section>
              <p className="micro-label">Subtasks</p>
              <div className="mt-2 flex flex-col gap-3">
                {waves.map(([wave, tasks]) => (
                  <div key={wave} className="rounded-xl border border-white/8 bg-black/20 p-3">
                    <p className="mb-2 flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.14em] text-mist-600">
                      <Zap size={10} className={tasks.length > 1 ? 'text-[var(--accent)]' : 'text-mist-600'} />
                      Wave {wave + 1}
                      {tasks.length > 1 ? ' · runs in parallel' : ' · sequential'}
                    </p>
                    <ul className="flex flex-col gap-2">
                      {tasks.map((task) => (
                        <li key={task.task_key} className="flex flex-wrap items-start gap-x-3 gap-y-1">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-xs font-medium text-mist-200">{task.title}</span>
                              <span className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/4 px-1.5 py-0.5 text-[10px] text-mist-400">
                                <Bot size={9} />
                                {task.agent_key}
                              </span>
                              {task.approval_required ? (
                                <Badge className="border border-gild-500/35 bg-gild-500/12 text-gild-400">
                                  approval required
                                </Badge>
                              ) : null}
                              {task.attempts > 1 ? (
                                <span className="text-[10px] text-mist-600">attempt {task.attempts}/{task.max_attempts}</span>
                              ) : null}
                            </div>
                            {showDeps && task.depends_on.length > 0 ? (
                              <p className="mt-1 text-[10.5px] text-mist-600">
                                depends on{' '}
                                {task.depends_on.map((dep, index) => (
                                  <span key={dep}>
                                    {index > 0 ? ', ' : ''}
                                    <span className="text-mist-400">
                                      {dep}
                                      {agentByKey.get(dep) ? ` (${agentByKey.get(dep)})` : ''}
                                    </span>
                                  </span>
                                ))}
                              </p>
                            ) : null}
                            {task.error ? (
                              <p className="mt-1 break-words text-[10.5px] text-rosh-400/90">{task.error}</p>
                            ) : null}
                          </div>
                          <TaskStatusDot status={task.status} />
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {/* Centralized Inter-Agent Messages */}
          {detail.messages && detail.messages.length > 0 ? (
            <section>
              <p className="micro-label">Centralized Agent Coordination ({detail.messages.length})</p>
              <div className="mt-2 flex max-h-40 flex-col gap-1.5 overflow-y-auto rounded-xl border border-white/8 bg-black/20 p-3">
                {detail.messages.map((msg) => (
                  <div key={msg.id} className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                    <span className="inline-flex items-center gap-1.5 text-mist-300">
                      <MessageSquareShare size={11} className="text-azure-400" />
                      <strong>{msg.senderKey}</strong> → <strong>{msg.recipientKey}</strong>
                      <span className="rounded bg-white/6 px-1.5 py-0.5 font-mono text-[9.5px] text-mist-400">
                        {msg.messageType}
                      </span>
                      <span className="truncate text-mist-400">{msg.subject}</span>
                    </span>
                    <span className="text-[10px] text-mist-600">{formatRelative(msg.createdAt)}</span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {/* Timeline */}
          {timeline.length > 0 ? (
            <section>
              <p className="micro-label">Activity timeline</p>
              <ol className="mt-2 flex flex-col gap-0.5 border-l border-white/8 pl-3">
                {timeline.map((event) => (
                  <li key={event.id} className="relative py-1">
                    <span
                      className={cn(
                        'absolute -left-[17px] top-2 h-1.5 w-1.5 rounded-full ring-2 ring-void-900',
                        event.type.includes('fail') || event.type.includes('cancel')
                          ? 'bg-rosh-400'
                          : event.type.includes('completed') || event.type.includes('saved') || event.type.includes('finished')
                            ? 'bg-verdant-400'
                            : 'bg-[var(--accent)]',
                      )}
                    />
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-[11.5px] text-mist-300">{EVENT_LABELS[event.type] ?? event.type}</span>
                      <span className="text-[10px] text-mist-600" title={formatDateTime(event.createdAt)}>
                        {formatRelative(event.createdAt)}
                      </span>
                    </div>
                    <EventPayload event={event.type} payload={event.payload} />
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          {/* Agent results with artifacts & citations */}
          {detail.results.length > 0 ? (
            <section>
              <p className="micro-label">Agent outputs</p>
              <div className="mt-2 flex flex-col gap-2">
                {detail.results.map((result) => (
                  <details
                    key={`${result.agentTaskId}-${result.attempt}`}
                    className="group rounded-xl border border-white/8 bg-black/20 px-3.5 py-2.5"
                  >
                    <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="flex items-center gap-2 text-mist-200">
                        <Bot size={12} className="text-[var(--accent)]" />
                        <span className="font-medium">{result.agent_key}</span>
                        <span className="text-mist-600">· {result.taskKey} · attempt {result.attempt}</span>
                        {result.durationMs != null ? (
                          <span className="font-mono text-[10px] text-mist-600">{result.durationMs}ms</span>
                        ) : null}
                      </span>
                      <span
                        className={cn(
                          'text-[11px]',
                          result.status === 'completed'
                            ? 'text-verdant-400'
                            : result.status === 'waiting_approval'
                              ? 'text-gild-300'
                              : result.status === 'cancelled'
                                ? 'text-mist-500'
                                : 'text-rosh-400',
                        )}
                      >
                        {result.status === 'completed'
                          ? 'Completed'
                          : result.status === 'waiting_approval'
                            ? 'Waiting Approval'
                            : result.status === 'cancelled'
                              ? 'Cancelled'
                              : 'Failed'}
                      </span>
                    </summary>
                    <div className="mt-2 border-t border-white/6 pt-2">
                      <p className="text-xs leading-relaxed text-mist-300">{result.result_summary}</p>
                      {result.detailed_output ? (
                        <p className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-black/30 p-2.5 text-[11.5px] leading-relaxed text-mist-400">
                          {result.detailed_output}
                        </p>
                      ) : null}
                      {result.artifacts && result.artifacts.length > 0 ? (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {result.artifacts.map((art, idx) => (
                            <span
                              key={idx}
                              className="rounded-md border border-white/10 bg-white/4 px-2 py-1 text-[10.5px] text-mist-300"
                            >
                              <strong className="font-mono uppercase text-[var(--accent)]">{art.kind}:</strong>{' '}
                              {art.title}
                            </span>
                          ))}
                        </div>
                      ) : null}
                      {result.source_references && result.source_references.length > 0 ? (
                        <div className="mt-2 flex flex-col gap-1">
                          {result.source_references.map((src, idx) => (
                            <div key={idx} className="flex items-center justify-between gap-2 text-[11px] text-mist-400">
                              <span className="truncate">• {src.title}</span>
                              {src.url ? (
                                <a
                                  href={src.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex shrink-0 items-center gap-1 text-azure-400 hover:underline"
                                >
                                  Citation <ExternalLink size={10} />
                                </a>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      ) : null}
                      {result.missing_information.length > 0 ? (
                        <p className="mt-2 text-[11px] text-gild-400">
                          Missing: {result.missing_information.join('; ')}
                        </p>
                      ) : null}
                      {result.errors.length > 0 ? (
                        <p className="mt-2 text-[11px] text-rosh-400">{result.errors.join(' · ')}</p>
                      ) : null}
                    </div>
                  </details>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}

function EventPayload({ event, payload }: { event: string; payload: Record<string, unknown> }) {
  let text = '';
  if (event === 'plan_created') {
    const count = payload.taskCount;
    const waves = payload.waves as number[] | undefined;
    text = `${count} subtask${count === 1 ? '' : 's'}${waves && waves.length > 1 ? ` across ${waves.length} waves` : ''}`;
    const warnings = payload.warnings as string[] | undefined;
    if (warnings && warnings.length > 0) text += ` · ${warnings.join('; ')}`;
  } else if (event === 'tasks_dispatched') {
    const byAgent = payload.byAgent as Record<string, number> | undefined;
    if (byAgent) text = Object.entries(byAgent).map(([key, count]) => `${key}×${count}`).join(', ');
  } else if (event === 'task_completed' || event === 'task_failed' || event === 'task_waiting') {
    const summary = (payload.summary as string) || '';
    const errors = (payload.errors as string[]) || [];
    text = summary || errors.join('; ');
  } else if (event === 'intent_understood') {
    text = (payload.objective as string) || '';
  } else if (event === 'evaluation_complete') {
    text = `verdict ${payload.verdict} · score ${payload.score}`;
  } else if (event === 'response_generated' || event === 'memory_saved' || event === 'memory_skipped') {
    text = (payload.headline as string) || (payload.title as string) || (payload.reason as string) || '';
  } else if (event === 'retry_scheduled') {
    text = `round ${payload.round} · tasks ${(payload.tasks as string[])?.join(', ') ?? ''}`;
  } else if (event === 'execution_failed' || event === 'step_failed') {
    text = (payload.error as string) || '';
  } else if (event === 'approval_checkpoints_created') {
    text = `held: ${(payload.tasks as string[])?.join(', ') ?? ''}`;
  }
  if (!text) return null;
  return <p className="mt-0.5 line-clamp-2 break-words text-[10.5px] leading-relaxed text-mist-600">{text}</p>;
}

export function ExecutionStatusPill({ status }: { status: ExecutionStatus }) {
  const meta = EXECUTION_STATUS_META[status];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium',
        meta.border,
        meta.bg,
        meta.text,
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', meta.dot, isLiveStatus(status) && 'animate-pulse')} />
      {meta.label}
    </span>
  );
}
