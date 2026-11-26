import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Activity,
  ArrowLeft,
  BarChart3,
  Check,
  Clock,
  ExternalLink,
  FileEdit,
  FlaskConical,
  KeyRound,
  ListTodo,
  PauseCircle,
  Pencil,
  Play,
  PlayCircle,
  Plus,
  Power,
  Save,
  ShieldAlert,
  Sparkles,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import { api, qs } from '../lib/api';
import type { Agent, AgentStatus, Task } from '../lib/types';
import {
  vozcore,
  type AgentDetailPayload,
  type ContentDraftDto,
  type DirectAgentTestResult,
} from '../lib/vozcore';
import { useToast } from '../context/ToastContext';
import { errorMessage } from '../context/AuthContext';
import { Button } from '../components/ui/Button';
import { Field, Input, Select, Textarea } from '../components/ui/Form';
import { StatusPill, Chip, Badge } from '../components/ui/Badge';
import { EmptyState, Spinner } from '../components/ui/Feedback';
import { WORKSPACE_PAUSE_EVENT } from '../hooks/useWorkspacePulse';
import { AGENT_STATUS_META, TASK_STATUS_META, agentIcon } from '../lib/constants';
import { cn, formatDateTime, formatRelative } from '../lib/utils';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

type DetailTab = 'overview' | 'capabilities' | 'tools' | 'history' | 'metrics' | 'test';

const TEST_PRESETS: Record<string, string> = {
  research:
    'Compare current enterprise AI agent orchestration architectures, separate verified facts from assumptions, and flag open questions.',
  inbox:
    'Draft a concise, executive-ready follow-up reply to a client asking for our Q4 VozLook Studios deliverable timeline (hold send for approval).',
  project:
    'Create a project plan for VozLook Studios Q4 Brand Refresh with 3 prioritized milestones and detect any delayed workspace tasks.',
  content:
    'Write a LinkedIn launch post and Instagram caption for VozLook Studios announcing our autonomous creative AI workflow.',
  finance:
    'Analyze our recorded workspace income and expenses, compare against active category budgets, and flag any unusual spend.',
  schedule:
    'Review today’s schedule in UTC, suggest focused deep-work blocks, and create a deadline reminder for Friday 15:00 UTC.',
  developer:
    'Write a Python function `merge_intervals(intervals)` with edge-case unit tests and execute the test suite in the isolated sandbox.',
  memory:
    'Store a reusable VozLook Studios brand note ("Primary palette: obsidian, electric violet, warm gold; tone: crisp, honest, executive") and verify retrieval.',
};

export function AgentDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  useDocumentTitle('Agent Workspace · VozPilot');

  const [tab, setTab] = useState<DetailTab>('overview');
  const [agent, setAgent] = useState<Agent | null>(null);
  const [detail, setDetail] = useState<AgentDetailPayload | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [drafts, setDrafts] = useState<ContentDraftDto[]>([]);
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftBody, setDraftBody] = useState('');
  const [savingDraft, setSavingDraft] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Profile form state
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<AgentStatus>('idle');
  const [responsibilities, setResponsibilities] = useState<string[]>([]);
  const [newResponsibility, setNewResponsibility] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Runtime instructions & limits state
  const [customInstructions, setCustomInstructions] = useState('');
  const [timeoutSeconds, setTimeoutSeconds] = useState(90);
  const [maxRetries, setMaxRetries] = useState(2);
  const [savingRuntime, setSavingRuntime] = useState(false);
  const [busyControl, setBusyControl] = useState<string | null>(null);

  // Test Agent state
  const [testPrompt, setTestPrompt] = useState('');
  const [testParamsJson, setTestParamsJson] = useState('{}');
  const [testing, setTesting] = useState(false);
  const [testOutput, setTestOutput] = useState<DirectAgentTestResult | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const data = await api.get<Agent>(`/api/agents/${id}`);
      setAgent(data);
      setName(data.name);
      setDescription(data.description);
      setStatus(data.status);
      setResponsibilities(data.responsibilities);
      setTestPrompt((prev) => prev || TEST_PRESETS[data.key] || '');

      const taskData = await api.get<{ tasks: Task[] }>(`/api/tasks${qs({ agentId: id, limit: 100 })}`);
      setTasks(taskData.tasks);

      try {
        const engineDetail = await vozcore.agentDetail(id);
        setDetail(engineDetail);
        setCustomInstructions(engineDetail.agent.customInstructions ?? '');
        setTimeoutSeconds(engineDetail.agent.timeoutSeconds ?? 90);
        setMaxRetries(engineDetail.agent.maxRetries ?? 2);
      } catch {
        setDetail(null);
      }

      if (data.key === 'content') {
        vozcore
          .listContentDrafts()
          .then(setDrafts)
          .catch(() => setDrafts([]));
      }
    } catch (caught) {
      setLoadError(errorMessage(caught));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const markDirty = <T,>(setter: (value: T) => void) => (value: T) => {
    setDirty(true);
    setter(value);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (name.trim().length < 2) {
      toast.error('Name too short', 'Agent name must be at least 2 characters.');
      return;
    }
    setSaving(true);
    try {
      const updated = await api.patch<Agent>(`/api/agents/${id}`, {
        name: name.trim(),
        description: description.trim(),
        status,
        responsibilities,
      });
      setAgent(updated);
      setDirty(false);
      window.dispatchEvent(new Event(WORKSPACE_PAUSE_EVENT));
      toast.success('Agent updated', `${updated.name} has been saved.`);
      void load();
    } catch (caught) {
      toast.error('Could not save agent', errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async () => {
    if (!agent) return;
    const nextEnabled = !(detail?.agent.enabled ?? agent.enabled ?? true);
    setBusyControl('enabled');
    try {
      await api.patch<Agent>(`/api/agents/${id}`, { enabled: nextEnabled });
      window.dispatchEvent(new Event(WORKSPACE_PAUSE_EVENT));
      toast.success(
        nextEnabled ? `${agent.name} enabled` : `${agent.name} disabled`,
        nextEnabled ? 'Agent can accept delegated tasks.' : 'Agent is disabled from VozCore routing.',
      );
      await load();
    } catch (caught) {
      toast.error('Could not update enabled state', errorMessage(caught));
    } finally {
      setBusyControl(null);
    }
  };

  const togglePause = async () => {
    if (!agent) return;
    const nextStatus: AgentStatus = agent.status === 'paused' ? 'idle' : 'paused';
    setBusyControl('pause');
    try {
      await api.patch<Agent>(`/api/agents/${id}`, { status: nextStatus });
      setStatus(nextStatus);
      window.dispatchEvent(new Event(WORKSPACE_PAUSE_EVENT));
      toast.success(nextStatus === 'paused' ? `${agent.name} paused` : `${agent.name} resumed`);
      await load();
    } catch (caught) {
      toast.error('Could not update pause state', errorMessage(caught));
    } finally {
      setBusyControl(null);
    }
  };

  const saveRuntimeConfig = async (event: FormEvent) => {
    event.preventDefault();
    setSavingRuntime(true);
    try {
      const updated = await vozcore.updateAgentRuntime(id, {
        customInstructions: customInstructions.trim() || null,
        timeoutSeconds,
        maxRetries,
      });
      setDetail(updated);
      toast.success('Runtime settings saved', 'System instructions and execution bounds updated.');
    } catch (caught) {
      toast.error('Could not save runtime settings', errorMessage(caught));
    } finally {
      setSavingRuntime(false);
    }
  };

  const handleToggleCapability = async (capKey: string, enabled: boolean) => {
    setBusyControl(`cap:${capKey}`);
    try {
      const updated = await vozcore.toggleCapability(id, capKey, enabled);
      setDetail(updated);
    } catch (caught) {
      toast.error('Could not update capability', errorMessage(caught));
    } finally {
      setBusyControl(null);
    }
  };

  const handleUpdateTool = async (
    toolKey: string,
    payload: { enabled?: boolean; requiresApproval?: boolean },
  ) => {
    setBusyControl(`tool:${toolKey}`);
    try {
      const updated = await vozcore.updateTool(id, toolKey, payload);
      setDetail(updated);
    } catch (caught) {
      toast.error('Could not update tool', errorMessage(caught));
    } finally {
      setBusyControl(null);
    }
  };

  const handleUpdatePermission = async (
    permKey: string,
    payload: {
      allowed?: boolean;
      requiresApproval?: boolean;
      rateLimitPerHour?: number;
      maxTasksPerRun?: number;
    },
  ) => {
    setBusyControl(`perm:${permKey}`);
    try {
      const updated = await vozcore.updatePermission(id, permKey, payload);
      setDetail(updated);
    } catch (caught) {
      toast.error('Could not update permission', errorMessage(caught));
    } finally {
      setBusyControl(null);
    }
  };

  const runLiveTest = async (event: FormEvent) => {
    event.preventDefault();
    if (testPrompt.trim().length < 3) {
      toast.error('Prompt too short', 'Enter at least 3 characters to test this agent.');
      return;
    }
    let parsedParams: Record<string, unknown> = {};
    if (testParamsJson.trim()) {
      try {
        const candidate = JSON.parse(testParamsJson);
        if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
          parsedParams = candidate as Record<string, unknown>;
        } else {
          toast.error('Invalid parameters', 'Parameters must be a JSON object like {}.');
          return;
        }
      } catch {
        toast.error('Invalid JSON', 'Check the JSON syntax in Optional Parameters.');
        return;
      }
    }

    setTesting(true);
    setTestOutput(null);
    try {
      const response = await vozcore.testAgent(id, {
        prompt: testPrompt.trim(),
        parameters: parsedParams,
      });
      setTestOutput(response);
      toast.success('Agent test finished', `Status: ${response.result.status}`);
      await load();
    } catch (caught) {
      toast.error('Agent test failed', errorMessage(caught));
    } finally {
      setTesting(false);
    }
  };

  const saveContentDraft = async (draftId: string) => {
    setSavingDraft(true);
    try {
      const updated = await vozcore.updateContentDraft(draftId, {
        title: draftTitle.trim(),
        body: draftBody,
      });
      setDrafts((prev) => prev.map((d) => (d.id === draftId ? updated : d)));
      setEditingDraftId(null);
      toast.success('Draft updated', 'Saved editable content draft to PostgreSQL.');
    } catch (caught) {
      toast.error('Could not save draft', errorMessage(caught));
    } finally {
      setSavingDraft(false);
    }
  };

  const addResponsibility = () => {
    const value = newResponsibility.trim();
    if (!value) return;
    if (responsibilities.length >= 12) {
      toast.error('Limit reached', 'An agent can have at most 12 responsibilities.');
      return;
    }
    setDirty(true);
    setResponsibilities((current) => [...current, value]);
    setNewResponsibility('');
  };

  if (loadError) {
    return (
      <div className="flex flex-col items-center gap-4 py-24">
        <EmptyState
          title="Couldn't load this agent"
          description={loadError}
          action={
            <div className="flex gap-2">
              <Button onClick={() => void load()}>Retry</Button>
              <Button variant="ghost" onClick={() => navigate('/agents')}>
                Back to Agent Hub
              </Button>
            </div>
          }
        />
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="flex justify-center py-24">
        <Spinner size={24} />
      </div>
    );
  }

  const Icon = agentIcon(agent.icon);
  const meta = AGENT_STATUS_META[status];
  const isVozCore = agent.key === 'vozcore';
  const isEnabled = detail?.agent.enabled ?? agent.enabled ?? true;
  const completedTotal =
    agent.taskCounts.completed + (detail?.metrics.completedTasks ?? agent.agentTaskCounts?.completed ?? 0);

  return (
    <div className="anim-enter flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          to="/agents"
          className="focus-ring inline-flex items-center gap-1.5 rounded-lg text-xs font-medium text-mist-400 transition hover:text-mist-200"
        >
          <ArrowLeft size={14} /> Agent Hub
        </Link>
        {dirty ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-gild-500/35 bg-gild-500/10 px-3 py-1 text-[11px] font-medium text-gild-400">
            <span className="h-1.5 w-1.5 rounded-full bg-gild-500" /> Unsaved profile changes
          </span>
        ) : null}
      </div>

      {/* Header card */}
      <div className="glass rounded-2xl p-5 sm:p-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            <span
              className={cn(
                'flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl border',
                isVozCore
                  ? 'border-[var(--accent)]/35 bg-[var(--accent-faint)] text-[var(--accent)]'
                  : 'border-white/10 bg-white/5 text-mist-300',
              )}
            >
              <Icon size={28} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="text-xl font-semibold tracking-tight text-mist-100">{agent.name}</h1>
                <StatusPill {...meta} pulse={status === 'active'} />
                {!isEnabled ? (
                  <Badge className="border border-rosh-400/35 bg-rosh-500/10 text-rosh-400">Disabled</Badge>
                ) : null}
                {isVozCore ? (
                  <Badge className="border border-gild-500/30 bg-gild-500/10 text-gild-400">
                    Central Orchestrator
                  </Badge>
                ) : null}
              </div>
              <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-mist-400">{agent.description}</p>
              <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-mist-500">
                <span className="inline-flex items-center gap-1.5">
                  <Clock size={12} /> Last active {formatRelative(agent.lastActiveAt)}
                </span>
                <span>
                  <strong className="text-mist-300">{completedTotal}</strong> completed ·{' '}
                  <strong className="text-mist-300">{detail?.metrics.failedTasks ?? 0}</strong> failed
                </span>
                {detail?.agent.currentTask ? (
                  <span className="text-[var(--accent)]">
                    Executing: {detail.agent.currentTask.title}
                  </span>
                ) : null}
              </div>
            </div>
          </div>

          {/* Operational quick controls */}
          {!isVozCore ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                loading={busyControl === 'pause'}
                icon={agent.status === 'paused' ? <PlayCircle size={14} /> : <PauseCircle size={14} />}
                onClick={() => void togglePause()}
              >
                {agent.status === 'paused' ? 'Resume' : 'Pause'}
              </Button>
              <Button
                size="sm"
                variant={isEnabled ? 'ghost' : 'primary'}
                loading={busyControl === 'enabled'}
                icon={<Power size={14} />}
                onClick={() => void toggleEnabled()}
              >
                {isEnabled ? 'Disable' : 'Enable'}
              </Button>
              <Button
                size="sm"
                variant="primary"
                icon={<FlaskConical size={14} />}
                onClick={() => setTab('test')}
              >
                Test Agent
              </Button>
            </div>
          ) : (
            <Link
              to="/command-center"
              className="focus-ring inline-flex items-center gap-2 rounded-xl bg-[var(--accent)] px-4 py-2 text-xs font-semibold text-white transition hover:brightness-110"
            >
              <Sparkles size={14} /> Open Command Center
            </Link>
          )}
        </div>

        {/* Workspace tabs */}
        <div className="mt-5 flex flex-wrap gap-2 border-t border-white/8 pt-4">
          <Chip active={tab === 'overview'} onClick={() => setTab('overview')}>
            <Pencil size={12} /> Overview
          </Chip>
          {!isVozCore ? (
            <>
              <Chip active={tab === 'capabilities'} onClick={() => setTab('capabilities')}>
                <Sparkles size={12} /> Capabilities & Instructions
              </Chip>
              <Chip active={tab === 'tools'} onClick={() => setTab('tools')}>
                <Wrench size={12} /> Tools & Permissions
              </Chip>
              <Chip active={tab === 'history'} onClick={() => setTab('history')}>
                <Activity size={12} /> Task History & Timeline
              </Chip>
              <Chip active={tab === 'metrics'} onClick={() => setTab('metrics')}>
                <BarChart3 size={12} /> Performance Metrics
              </Chip>
              <Chip active={tab === 'test'} onClick={() => setTab('test')}>
                <FlaskConical size={12} /> Test Agent
              </Chip>
            </>
          ) : null}
        </div>
      </div>

      {/* TAB 1: OVERVIEW */}
      {tab === 'overview' ? (
        <div className="grid gap-4 xl:grid-cols-5">
          <form onSubmit={save} className="glass flex flex-col rounded-2xl p-5 xl:col-span-3">
            <div className="mb-4 flex items-center gap-2">
              <Pencil size={14} className="text-[var(--accent)]" />
              <h2 className="text-sm font-semibold text-mist-100">Configuration</h2>
            </div>

            <div className="flex flex-col gap-4">
              <Field label="Agent name" htmlFor="agent-name">
                <Input
                  id="agent-name"
                  value={name}
                  onChange={(event) => markDirty(setName)(event.target.value)}
                  maxLength={80}
                  required
                />
              </Field>

              <Field
                label="Description"
                htmlFor="agent-desc"
                hint="What this agent is responsible for, in plain language."
              >
                <Textarea
                  id="agent-desc"
                  value={description}
                  onChange={(event) => markDirty(setDescription)(event.target.value)}
                  maxLength={600}
                  rows={3}
                />
              </Field>

              <Field
                label="Operational status"
                htmlFor="agent-status"
                hint="Paused or Error agents are automatically skipped during VozCore routing."
              >
                <Select
                  id="agent-status"
                  value={status}
                  onChange={(event) => markDirty(setStatus)(event.target.value as AgentStatus)}
                >
                  <option value="active">Active</option>
                  <option value="idle">Idle</option>
                  <option value="paused">Paused</option>
                  <option value="error">Error</option>
                </Select>
              </Field>

              {/* Responsibilities */}
              <div className="flex flex-col gap-2">
                <span className="text-xs font-medium text-mist-300">Responsibilities</span>
                {responsibilities.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-white/10 px-3.5 py-3 text-xs text-mist-500">
                    No responsibilities listed yet.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-1.5">
                    {responsibilities.map((item, index) => (
                      <li
                        key={`${item}-${index}`}
                        className="flex items-center gap-2 rounded-xl border border-white/8 bg-white/3 px-3 py-2"
                      >
                        <Check size={13} className="shrink-0 text-verdant-400" />
                        <span className="min-w-0 flex-1 text-xs text-mist-200">{item}</span>
                        <button
                          type="button"
                          onClick={() => {
                            setDirty(true);
                            setResponsibilities((current) => current.filter((_, i) => i !== index));
                          }}
                          aria-label={`Remove ${item}`}
                          className="focus-ring rounded p-1 text-mist-500 transition hover:text-rosh-400"
                        >
                          <X size={13} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="flex gap-2">
                  <Input
                    value={newResponsibility}
                    onChange={(event) => setNewResponsibility(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        addResponsibility();
                      }
                    }}
                    placeholder="Add a responsibility…"
                    maxLength={180}
                  />
                  <Button
                    onClick={addResponsibility}
                    disabled={!newResponsibility.trim()}
                    icon={<Plus size={14} />}
                  >
                    Add
                  </Button>
                </div>
              </div>

              <div className="mt-1 flex items-center justify-between gap-3 border-t border-white/7 pt-4">
                <p className="text-[11px] text-mist-600">Changes are recorded in the Activity Center.</p>
                <Button
                  type="submit"
                  variant="primary"
                  loading={saving}
                  disabled={!dirty}
                  icon={<Save size={15} />}
                >
                  Save changes
                </Button>
              </div>
            </div>
          </form>

          {/* Right column */}
          <div className="flex flex-col gap-4 xl:col-span-2">
            {/* Assigned tasks */}
            <div className="glass rounded-2xl p-5">
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ListTodo size={14} className="text-gild-400" />
                  <h2 className="text-sm font-semibold text-mist-100">Assigned tasks</h2>
                </div>
                <Link
                  to={`/tasks${qs({ agentId: agent.id })}`}
                  className="focus-ring text-[11px] font-medium text-[var(--accent)] hover:underline"
                >
                  View all
                </Link>
              </div>
              {tasks.length === 0 ? (
                <EmptyState
                  compact
                  title="No tasks assigned"
                  description={`Tasks assigned to ${agent.name} will appear here.`}
                  action={
                    <Link
                      to="/tasks"
                      className="focus-ring rounded-lg border border-white/12 px-3.5 py-1.5 text-xs text-mist-300 hover:bg-white/6"
                    >
                      Open Task Manager
                    </Link>
                  }
                />
              ) : (
                <ul className="flex flex-col divide-y divide-white/6">
                  {tasks.slice(0, 6).map((task) => (
                    <li key={task.id} className="flex items-center gap-3 py-2.5">
                      <span className="min-w-0 flex-1 truncate text-xs text-mist-200">{task.title}</span>
                      <StatusPill {...TASK_STATUS_META[task.status]} />
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-3 border-t border-white/7 pt-3 text-[11px] text-mist-600">
                Last updated {formatDateTime(agent.updatedAt)}
              </p>
            </div>

            {/* Quick status */}
            <div className="glass rounded-2xl p-5">
              <h2 className="mb-3 text-sm font-semibold text-mist-100">Quick status</h2>
              <div className="flex flex-wrap gap-2">
                {(['active', 'idle', 'paused', 'error'] as AgentStatus[]).map((option) => (
                  <Chip
                    key={option}
                    active={status === option}
                    onClick={() => {
                      markDirty(setStatus)(option);
                    }}
                  >
                    {AGENT_STATUS_META[option].label}
                  </Chip>
                ))}
              </div>
              <p className="mt-3 text-[11px] text-mist-600">
                Selecting a status stages it above — hit <strong className="text-mist-400">Save changes</strong> to persist.
              </p>
            </div>
          </div>

          {/* Content Drafts Studio (Content Agent only) */}
          {agent.key === 'content' ? (
            <div className="glass rounded-2xl p-5 xl:col-span-5">
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <FileEdit size={15} className="text-[var(--accent)]" />
                  <h2 className="text-sm font-semibold text-mist-100">
                    Editable Content Drafts ({drafts.length})
                  </h2>
                </div>
                <span className="text-[11px] text-mist-500">
                  External publication always requires human approval in Approval Center
                </span>
              </div>
              {drafts.length === 0 ? (
                <EmptyState
                  compact
                  title="No content drafts saved yet"
                  description="Run Content Agent in Command Center or Test Agent to generate editable VozLook Studios drafts."
                />
              ) : (
                <div className="grid gap-3 md:grid-cols-2">
                  {drafts.map((draft) => {
                    const isEditing = editingDraftId === draft.id;
                    return (
                      <div key={draft.id} className="rounded-xl border border-white/10 bg-black/25 p-4">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge className="border border-white/10 bg-white/5 text-mist-300">
                                {draft.contentType}
                              </Badge>
                              <Badge className="border border-gild-500/30 bg-gild-500/10 text-gild-300">
                                {draft.brandName}
                              </Badge>
                              <Badge
                                className={cn(
                                  'border',
                                  draft.status === 'approved'
                                    ? 'border-verdant-500/35 bg-verdant-500/10 text-verdant-400'
                                    : draft.status === 'pending_approval'
                                      ? 'border-gild-400/35 bg-gild-400/10 text-gild-300'
                                      : 'border-white/10 bg-white/5 text-mist-400',
                                )}
                              >
                                {draft.status}
                              </Badge>
                            </div>
                            {!isEditing ? (
                              <h3 className="mt-2 text-sm font-semibold text-mist-100">{draft.title}</h3>
                            ) : null}
                          </div>
                          {!isEditing ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setEditingDraftId(draft.id);
                                setDraftTitle(draft.title);
                                setDraftBody(draft.body);
                              }}
                            >
                              Edit
                            </Button>
                          ) : null}
                        </div>

                        {isEditing ? (
                          <div className="mt-3 flex flex-col gap-2.5">
                            <Input
                              value={draftTitle}
                              onChange={(event) => setDraftTitle(event.target.value)}
                              maxLength={200}
                            />
                            <Textarea
                              value={draftBody}
                              onChange={(event) => setDraftBody(event.target.value)}
                              rows={6}
                            />
                            <div className="flex justify-end gap-2">
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setEditingDraftId(null)}
                                disabled={savingDraft}
                              >
                                Cancel
                              </Button>
                              <Button
                                size="sm"
                                variant="primary"
                                loading={savingDraft}
                                onClick={() => void saveContentDraft(draft.id)}
                              >
                                Save draft
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <p className="mt-2 line-clamp-5 whitespace-pre-wrap text-xs leading-relaxed text-mist-400">
                            {draft.body}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* TAB 2: CAPABILITIES & SYSTEM INSTRUCTIONS */}
      {tab === 'capabilities' ? (
        <div className="grid gap-4 xl:grid-cols-2">
          <div className="glass rounded-2xl p-5">
            <h2 className="text-sm font-semibold text-mist-100">Declared Capabilities</h2>
            <p className="mt-1 text-xs text-mist-500">
              Toggle individual capabilities for this workspace. Disabled capabilities are withheld from agent prompts.
            </p>
            {!detail || detail.capabilities.length === 0 ? (
              <p className="mt-4 text-xs text-mist-500">
                Start the VozCore engine (`npm run vozcore`) to inspect and toggle runtime capabilities.
              </p>
            ) : (
              <ul className="mt-4 flex flex-col gap-2.5">
                {detail.capabilities.map((cap) => (
                  <li
                    key={cap.capabilityKey}
                    className="flex items-start justify-between gap-3 rounded-xl border border-white/8 bg-white/3 p-3.5"
                  >
                    <div>
                      <p className="text-xs font-semibold text-mist-100">{cap.label}</p>
                      <p className="mt-0.5 text-[11.5px] leading-relaxed text-mist-400">{cap.description}</p>
                      <code className="mt-1 inline-block font-mono text-[10px] text-mist-600">
                        {cap.capabilityKey}
                      </code>
                    </div>
                    <Button
                      size="sm"
                      variant={cap.enabled ? 'primary' : 'secondary'}
                      loading={busyControl === `cap:${cap.capabilityKey}`}
                      onClick={() => void handleToggleCapability(cap.capabilityKey, !cap.enabled)}
                    >
                      {cap.enabled ? 'Enabled' : 'Disabled'}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <form onSubmit={saveRuntimeConfig} className="glass flex flex-col gap-4 rounded-2xl p-5">
            <div>
              <h2 className="text-sm font-semibold text-mist-100">System Instructions & Execution Policy</h2>
              <p className="mt-1 text-xs text-mist-500">
                Custom workspace instructions append to the specialist’s core safety prompt and cannot bypass security boundaries.
              </p>
            </div>

            {detail?.agent.defaultInstructions ? (
              <div>
                <span className="text-xs font-medium text-mist-400">Built-in Specialist Blueprint (read-only)</span>
                <pre className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-xl border border-white/8 bg-black/35 p-3 font-mono text-[11px] leading-relaxed text-mist-400">
                  {detail.agent.defaultInstructions}
                </pre>
              </div>
            ) : null}

            <Field
              label="Workspace Custom Instructions"
              htmlFor="custom-instructions"
              hint="Optional brand rules, domain preferences, or formatting guidelines for this agent."
            >
              <Textarea
                id="custom-instructions"
                value={customInstructions}
                onChange={(event) => setCustomInstructions(event.target.value)}
                rows={4}
                maxLength={4000}
                placeholder="e.g. Default to VozLook Studios brand voice; summarize findings in executive bullet points."
              />
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Execution Timeout (seconds)" htmlFor="timeout-sec" hint="5–600 seconds per task">
                <Input
                  id="timeout-sec"
                  type="number"
                  min={5}
                  max={600}
                  value={timeoutSeconds}
                  onChange={(event) => setTimeoutSeconds(Number(event.target.value || 90))}
                />
              </Field>
              <Field label="Max Retry Attempts" htmlFor="max-retries" hint="0–5 retries on transient errors">
                <Input
                  id="max-retries"
                  type="number"
                  min={0}
                  max={5}
                  value={maxRetries}
                  onChange={(event) => setMaxRetries(Number(event.target.value || 0))}
                />
              </Field>
            </div>

            <div className="flex justify-end border-t border-white/8 pt-3">
              <Button type="submit" variant="primary" loading={savingRuntime} icon={<Save size={14} />}>
                Save Runtime Policy
              </Button>
            </div>
          </form>
        </div>
      ) : null}

      {/* TAB 3: TOOLS & PERMISSIONS */}
      {tab === 'tools' ? (
        <div className="grid gap-4 xl:grid-cols-2">
          <div className="glass rounded-2xl p-5">
            <div className="flex items-center gap-2">
              <Wrench size={14} className="text-[var(--accent)]" />
              <h2 className="text-sm font-semibold text-mist-100">Tool Configuration</h2>
            </div>
            <p className="mt-1 text-xs text-mist-500">
              Private tools registered exclusively to {agent.name}. Agents cannot invoke another agent’s tools directly.
            </p>
            {!detail || detail.tools.length === 0 ? (
              <p className="mt-4 text-xs text-mist-500">No tools loaded — ensure VozCore engine is running.</p>
            ) : (
              <ul className="mt-4 flex flex-col gap-2.5">
                {detail.tools.map((tool) => (
                  <li
                    key={tool.toolKey}
                    className="rounded-xl border border-white/8 bg-white/3 p-3.5"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-xs font-semibold text-mist-100">{tool.label}</span>
                          {tool.provider ? (
                            <Badge className="border border-azure-400/30 bg-azure-500/10 text-azure-400">
                              oauth:{tool.provider}
                            </Badge>
                          ) : null}
                          {tool.requiresApproval ? (
                            <Badge className="border border-gild-500/35 bg-gild-500/12 text-gild-300">
                              requires approval
                            </Badge>
                          ) : null}
                        </div>
                        <p className="mt-1 text-[11.5px] text-mist-400">{tool.description}</p>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={busyControl === `tool:${tool.toolKey}`}
                          onClick={() =>
                            void handleUpdateTool(tool.toolKey, { requiresApproval: !tool.requiresApproval })
                          }
                        >
                          {tool.requiresApproval ? 'Approval On' : 'Auto'}
                        </Button>
                        <Button
                          size="sm"
                          variant={tool.enabled ? 'primary' : 'secondary'}
                          loading={busyControl === `tool:${tool.toolKey}`}
                          onClick={() => void handleUpdateTool(tool.toolKey, { enabled: !tool.enabled })}
                        >
                          {tool.enabled ? 'Enabled' : 'Disabled'}
                        </Button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="glass rounded-2xl p-5">
            <div className="flex items-center gap-2">
              <KeyRound size={14} className="text-gild-400" />
              <h2 className="text-sm font-semibold text-mist-100">Permissions & Rate Limits</h2>
            </div>
            <p className="mt-1 text-xs text-mist-500">
              Enforced server-side before every execution. Disallowed permissions raise an immediate security rejection.
            </p>
            {!detail || detail.permissions.length === 0 ? (
              <p className="mt-4 text-xs text-mist-500">No permissions loaded — ensure VozCore engine is running.</p>
            ) : (
              <ul className="mt-4 flex flex-col gap-2.5">
                {detail.permissions.map((perm) => (
                  <li
                    key={perm.permissionKey}
                    className="rounded-xl border border-white/8 bg-white/3 p-3.5"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <code className="font-mono text-xs font-semibold text-mist-100">
                          {perm.permissionKey}
                        </code>
                        <p className="mt-0.5 text-[11px] text-mist-500">
                          Scope: {perm.scope} · Rate limit: {perm.rateLimitPerHour}/hr · Max tasks/run:{' '}
                          {perm.maxTasksPerRun}
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={busyControl === `perm:${perm.permissionKey}`}
                          onClick={() =>
                            void handleUpdatePermission(perm.permissionKey, {
                              requiresApproval: !perm.requiresApproval,
                            })
                          }
                        >
                          <ShieldAlert size={12} />
                          {perm.requiresApproval ? 'Approval Gate' : 'Direct'}
                        </Button>
                        <Button
                          size="sm"
                          variant={perm.allowed ? 'primary' : 'danger'}
                          loading={busyControl === `perm:${perm.permissionKey}`}
                          onClick={() =>
                            void handleUpdatePermission(perm.permissionKey, { allowed: !perm.allowed })
                          }
                        >
                          {perm.allowed ? 'Allowed' : 'Blocked'}
                        </Button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}

      {/* TAB 4: TASK HISTORY & ACTIVITY TIMELINE */}
      {tab === 'history' ? (
        <div className="grid gap-4 xl:grid-cols-2">
          <div className="glass rounded-2xl p-5">
            <h2 className="text-sm font-semibold text-mist-100">Delegated Subtask History</h2>
            {!detail || detail.taskHistory.length === 0 ? (
              <div className="mt-4">
                <EmptyState
                  compact
                  title="No delegated subtasks yet"
                  description="Subtasks assigned by VozCore or Test Agent will appear here with real status and attempt counts."
                />
              </div>
            ) : (
              <ul className="mt-3 flex flex-col divide-y divide-white/8">
                {detail.taskHistory.map((item) => (
                  <li key={item.id} className="py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-mist-100">{item.title}</span>
                      <Badge
                        className={cn(
                          'border',
                          item.status === 'completed'
                            ? 'border-verdant-500/35 bg-verdant-500/10 text-verdant-400'
                            : item.status === 'failed'
                              ? 'border-rosh-500/35 bg-rosh-500/10 text-rosh-400'
                              : item.status === 'waiting'
                                ? 'border-gild-400/35 bg-gild-400/10 text-gild-300'
                                : 'border-white/10 bg-white/5 text-mist-300',
                        )}
                      >
                        {item.status} · attempt {item.attempts}/{item.maxAttempts}
                      </Badge>
                    </div>
                    <p className="mt-1 line-clamp-2 text-[11.5px] text-mist-400">{item.description}</p>
                    {item.error ? (
                      <p className="mt-1 text-[11px] text-rosh-400">{item.error}</p>
                    ) : null}
                    <p className="mt-1 text-[10.5px] text-mist-600">{formatRelative(item.createdAt)}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex flex-col gap-4">
            <div className="glass rounded-2xl p-5">
              <h2 className="text-sm font-semibold text-mist-100">Audit Execution Timeline</h2>
              {!detail || detail.logs.length === 0 ? (
                <div className="mt-4">
                  <EmptyState
                    compact
                    title="No execution logs recorded yet"
                    description="Audit events appear here whenever this agent runs, retries, or hits a permission gate."
                  />
                </div>
              ) : (
                <ol className="mt-3 flex max-h-80 flex-col gap-2 overflow-y-auto border-l border-white/10 pl-3">
                  {detail.logs.map((log) => (
                    <li key={log.id} className="text-xs">
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            'font-mono text-[10.5px] uppercase',
                            log.level === 'error'
                              ? 'text-rosh-400'
                              : log.level === 'warn'
                                ? 'text-gild-400'
                                : 'text-verdant-400',
                          )}
                        >
                          {log.action}
                        </span>
                        {log.durationMs !== null ? (
                          <span className="font-mono text-[10px] text-mist-500">{log.durationMs}ms</span>
                        ) : null}
                        <span className="text-[10px] text-mist-600">{formatRelative(log.createdAt)}</span>
                      </div>
                      <p className="mt-0.5 text-[11.5px] text-mist-300">{log.message}</p>
                    </li>
                  ))}
                </ol>
              )}
            </div>

            <div className="glass rounded-2xl p-5">
              <h2 className="text-sm font-semibold text-mist-100">Inter-Agent Messages (via VozCore)</h2>
              {!detail || detail.messages.length === 0 ? (
                <p className="mt-2 text-xs text-mist-500">
                  No centralized coordination messages recorded for this agent yet.
                </p>
              ) : (
                <ul className="mt-3 flex max-h-60 flex-col gap-2 overflow-y-auto">
                  {detail.messages.map((msg) => (
                    <li key={msg.id} className="rounded-xl border border-white/8 bg-black/25 px-3 py-2 text-xs">
                      <div className="flex items-center justify-between text-[10.5px] text-mist-500">
                        <span>
                          <strong className="text-mist-300">{msg.senderKey}</strong> →{' '}
                          <strong className="text-mist-300">{msg.recipientKey}</strong> · {msg.messageType}
                        </span>
                        <span>{formatRelative(msg.createdAt)}</span>
                      </div>
                      <p className="mt-1 text-mist-200">{msg.subject}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {/* TAB 5: PERFORMANCE METRICS */}
      {tab === 'metrics' ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="glass rounded-2xl p-5">
            <p className="text-xs text-mist-500">Completed Subtasks</p>
            <p className="mt-2 font-mono text-2xl font-semibold text-verdant-400">
              {detail?.metrics.completedTasks ?? 0}
            </p>
            <p className="mt-1 text-[11px] text-mist-500">
              Out of {detail?.metrics.totalTasks ?? 0} total delegated subtasks
            </p>
          </div>
          <div className="glass rounded-2xl p-5">
            <p className="text-xs text-mist-500">Failures & Retries</p>
            <p className="mt-2 font-mono text-2xl font-semibold text-rosh-400">
              {detail?.metrics.failedTasks ?? 0}
            </p>
            <p className="mt-1 text-[11px] text-mist-500">
              {detail?.metrics.retriedTasks ?? 0} tasks required retry · {detail?.metrics.waitingTasks ?? 0} waiting approval
            </p>
          </div>
          <div className="glass rounded-2xl p-5">
            <p className="text-xs text-mist-500">Average Execution Duration</p>
            <p className="mt-2 font-mono text-2xl font-semibold text-mist-100">
              {detail?.metrics.avgDurationMs !== null && detail?.metrics.avgDurationMs !== undefined
                ? `${Math.round(detail.metrics.avgDurationMs)} ms`
                : '—'}
            </p>
            <p className="mt-1 text-[11px] text-mist-500">
              Measured across {detail?.metrics.usageCalls ?? 0} recorded executions
            </p>
          </div>
          <div className="glass rounded-2xl p-5">
            <p className="text-xs text-mist-500">Token & Cost Telemetry</p>
            <p className="mt-2 font-mono text-2xl font-semibold text-gild-400">
              {(detail?.metrics.totalTokens ?? 0).toLocaleString()} tok
            </p>
            <p className="mt-1 text-[11px] text-mist-500">
              {detail?.metrics.estimatedCostUsd !== null && detail?.metrics.estimatedCostUsd !== undefined
                ? `Est. $${detail.metrics.estimatedCostUsd.toFixed(4)} USD`
                : 'Cost estimation requires MODEL_*_COST_PER_1M_USD'}
            </p>
          </div>
        </div>
      ) : null}

      {/* TAB 6: LIVE TEST AGENT */}
      {tab === 'test' ? (
        <div className="grid gap-4 xl:grid-cols-5">
          <form onSubmit={runLiveTest} className="glass flex flex-col gap-4 rounded-2xl p-5 xl:col-span-2">
            <div className="flex items-center gap-2">
              <FlaskConical size={15} className="text-[var(--accent)]" />
              <h2 className="text-sm font-semibold text-mist-100">Test {agent.name} Live</h2>
            </div>
            <p className="text-xs leading-relaxed text-mist-400">
              Dispatches a real single-agent execution through VozCore using the Common Agent Interface, enforcing all permissions, rate limits, and approval gates.
            </p>

            <Field label="Task Prompt" htmlFor="test-prompt">
              <Textarea
                id="test-prompt"
                value={testPrompt}
                onChange={(event) => setTestPrompt(event.target.value)}
                rows={5}
                maxLength={4000}
                placeholder={`Give ${agent.name} a concrete assignment…`}
                required
              />
            </Field>

            <Field
              label="Optional Parameters (JSON)"
              htmlFor="test-params"
              hint="Structured context passed alongside the prompt."
            >
              <Textarea
                id="test-params"
                value={testParamsJson}
                onChange={(event) => setTestParamsJson(event.target.value)}
                rows={2}
                className="font-mono text-xs"
              />
            </Field>

            <Button
              type="submit"
              variant="primary"
              loading={testing}
              icon={<Play size={14} />}
            >
              {testing ? 'Executing Specialist…' : `Run ${agent.name}`}
            </Button>
          </form>

          <div className="glass rounded-2xl p-5 xl:col-span-3">
            <h2 className="text-sm font-semibold text-mist-100">Structured Agent Output</h2>
            {!testOutput && !testing ? (
              <div className="mt-6">
                <EmptyState
                  compact
                  icon={<FlaskConical size={18} />}
                  title="Ready to run"
                  description="Submit a prompt on the left to inspect real structured output, artifacts, citations, and telemetry."
                />
              </div>
            ) : testing ? (
              <div className="flex flex-col items-center justify-center gap-3 py-16 text-xs text-mist-400">
                <Spinner size={22} />
                <span>Executing {agent.name} via VozCore…</span>
              </div>
            ) : testOutput ? (
              <div className="mt-3 flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/8 bg-black/30 px-3.5 py-2.5 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      className={cn(
                        'border',
                        testOutput.result.status === 'completed'
                          ? 'border-verdant-500/35 bg-verdant-500/12 text-verdant-400'
                          : testOutput.result.status === 'waiting_approval'
                            ? 'border-gild-400/35 bg-gild-400/12 text-gild-300'
                            : 'border-rosh-500/35 bg-rosh-500/12 text-rosh-400',
                      )}
                    >
                      {testOutput.result.status}
                    </Badge>
                    {testOutput.result.duration_ms != null ? (
                      <span className="font-mono text-[11px] text-mist-400">
                        {testOutput.result.duration_ms}ms
                      </span>
                    ) : null}
                    {testOutput.result.total_tokens != null ? (
                      <span className="font-mono text-[11px] text-mist-500">
                        {testOutput.result.total_tokens} tokens
                      </span>
                    ) : null}
                  </div>
                  <code className="font-mono text-[10.5px] text-mist-500">
                    exec:{testOutput.result.execution_id.slice(0, 8)}
                  </code>
                </div>

                <div>
                  <p className="micro-label">Summary</p>
                  <p className="mt-1 text-xs leading-relaxed text-mist-200">{testOutput.result.summary}</p>
                </div>

                {testOutput.result.detailed_output ? (
                  <div>
                    <p className="micro-label">Detailed Output</p>
                    <pre className="mt-1 max-h-72 overflow-y-auto whitespace-pre-wrap rounded-xl border border-white/8 bg-black/35 p-3 text-xs leading-relaxed text-mist-300">
                      {testOutput.result.detailed_output}
                    </pre>
                  </div>
                ) : null}

                {testOutput.result.artifacts.length > 0 ? (
                  <div>
                    <p className="micro-label">Artifacts ({testOutput.result.artifacts.length})</p>
                    <div className="mt-1.5 flex flex-col gap-2">
                      {testOutput.result.artifacts.map((art, idx) => (
                        <div key={idx} className="rounded-xl border border-white/8 bg-white/3 p-3 text-xs">
                          <span className="font-mono text-[10px] uppercase text-[var(--accent)]">
                            {art.kind}
                          </span>{' '}
                          <strong className="text-mist-100">{art.title}</strong>
                          {art.content !== undefined ? (
                            <pre className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap font-mono text-[11px] text-mist-400">
                              {typeof art.content === 'string'
                                ? art.content
                                : JSON.stringify(art.content, null, 2)}
                            </pre>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                {testOutput.result.source_references.length > 0 ? (
                  <div>
                    <p className="micro-label">Sources & Citations</p>
                    <ul className="mt-1.5 flex flex-col gap-1.5">
                      {testOutput.result.source_references.map((src, idx) => (
                        <li key={idx} className="flex items-center justify-between gap-2 rounded-lg border border-white/8 bg-black/25 px-3 py-2 text-xs">
                          <span className="truncate text-mist-200">{src.title}</span>
                          {src.url ? (
                            <a
                              href={src.url}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex shrink-0 items-center gap-1 text-[11px] text-azure-400 hover:underline"
                            >
                              Source <ExternalLink size={11} />
                            </a>
                          ) : (
                            <span className="text-[10.5px] text-mist-500">{src.provider ?? 'internal'}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {testOutput.result.error_details ? (
                  <div className="rounded-xl border border-rosh-500/35 bg-rosh-500/10 p-3 text-xs text-rosh-400">
                    {Array.isArray(testOutput.result.error_details)
                      ? testOutput.result.error_details.join(' · ')
                      : String(
                          (testOutput.result.error_details as Record<string, unknown>).message ??
                            JSON.stringify(testOutput.result.error_details),
                        )}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Footer note */}
      <p className="flex items-center gap-1.5 text-[11px] text-mist-600">
        <Trash2 size={11} className="text-mist-600" />
        Agent profiles are permanent — their configuration, permissions, and status remain yours to change.
      </p>
    </div>
  );
}
