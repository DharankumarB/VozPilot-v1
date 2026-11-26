import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Check,
  Clock,
  ListTodo,
  Pencil,
  Plus,
  Save,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { api, qs } from '../lib/api';
import type { Agent, AgentStatus, Task } from '../lib/types';
import { useToast } from '../context/ToastContext';
import { errorMessage } from '../context/AuthContext';
import { Button } from '../components/ui/Button';
import { Field, Input, Select, Textarea } from '../components/ui/Form';
import { StatusPill, Chip } from '../components/ui/Badge';
import { EmptyState, Spinner } from '../components/ui/Feedback';
import { AGENT_STATUS_META, TASK_STATUS_META, agentIcon } from '../lib/constants';
import { cn, formatDateTime, formatRelative } from '../lib/utils';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

export function AgentDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  useDocumentTitle('Configure agent · VozPilot');

  const [agent, setAgent] = useState<Agent | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<AgentStatus>('idle');
  const [responsibilities, setResponsibilities] = useState<string[]>([]);
  const [newResponsibility, setNewResponsibility] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const data = await api.get<Agent>(`/api/agents/${id}`);
      setAgent(data);
      setName(data.name);
      setDescription(data.description);
      setStatus(data.status);
      setResponsibilities(data.responsibilities);
      const taskData = await api.get<{ tasks: Task[] }>(`/api/tasks${qs({ agentId: id, limit: 100 })}`);
      setTasks(taskData.tasks);
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
      toast.success('Agent updated', `${updated.name} has been saved.`);
    } catch (caught) {
      toast.error('Could not save agent', errorMessage(caught));
    } finally {
      setSaving(false);
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
            <span className="h-1.5 w-1.5 rounded-full bg-gild-500" /> Unsaved changes
          </span>
        ) : null}
      </div>

      {/* Header card */}
      <div className="glass rounded-2xl p-5 sm:p-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
          <span
            className={cn(
              'flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl border',
              agent.key === 'vozcore'
                ? 'border-[var(--accent)]/35 bg-[var(--accent-faint)] text-[var(--accent)]'
                : 'border-white/10 bg-white/5 text-mist-300',
            )}
          >
            <Icon size={28} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-xl font-semibold tracking-tight text-mist-100">{agent.name}</h1>
              <StatusPill {...meta} pulse={status === 'active'} />
            </div>
            <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-mist-400">{agent.description}</p>
            <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-mist-500">
              <span className="inline-flex items-center gap-1.5">
                <Clock size={12} /> Last active {formatRelative(agent.lastActiveAt)}
              </span>
              <span>
                {agent.taskCounts.open} open · {agent.taskCounts.completed} completed · {agent.taskCounts.total} assigned
              </span>
              <span>Updated {formatRelative(agent.updatedAt)}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-5">
        {/* Configuration form */}
        <form onSubmit={save} className="glass flex flex-col rounded-2xl p-5 xl:col-span-3">
          <div className="mb-4 flex items-center gap-2">
            <Pencil size={14} className="text-[var(--accent)]" />
            <h2 className="text-sm font-semibold text-mist-100">Configuration</h2>
          </div>

          <div className="flex flex-col gap-4">
            <Field label="Agent name" htmlFor="agent-name">
              <Input id="agent-name" value={name} onChange={(event) => markDirty(setName)(event.target.value)} maxLength={80} required />
            </Field>

            <Field label="Description" htmlFor="agent-desc" hint="What this agent is responsible for, in plain language.">
              <Textarea
                id="agent-desc"
                value={description}
                onChange={(event) => markDirty(setDescription)(event.target.value)}
                maxLength={600}
                rows={3}
              />
            </Field>

            <Field label="Status" htmlFor="agent-status" hint="Profile state only — agents begin executing work in Phase 2.">
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
                <Button onClick={addResponsibility} disabled={!newResponsibility.trim()} icon={<Plus size={14} />}>
                  Add
                </Button>
              </div>
            </div>

            <div className="mt-1 flex items-center justify-between gap-3 border-t border-white/7 pt-4">
              <p className="text-[11px] text-mist-600">
                Changes are recorded in the Activity Center.
              </p>
              <Button type="submit" variant="primary" loading={saving} disabled={!dirty} icon={<Save size={15} />}>
                Save changes
              </Button>
            </div>
          </div>
        </form>

        {/* Right column */}
        <div className="flex flex-col gap-4 xl:col-span-2">
          {/* Phase 2 panel */}
          <div className="rounded-2xl border border-dashed border-[var(--accent)]/30 bg-[var(--accent-faint)] p-5">
            <div className="flex items-center gap-2">
              <Sparkles size={14} className="text-[var(--accent)]" />
              <h2 className="text-sm font-semibold text-mist-100">AI configuration</h2>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-mist-400">
              Runtime controls — model selection, autonomy level, delegation policy and tool access —
              activate when VozCore orchestration goes live in Phase 2.
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {['Model', 'Autonomy level', 'Tool access', 'Delegation policy'].map((item) => (
                <span
                  key={item}
                  className="rounded-md border border-white/10 bg-white/4 px-2 py-1 text-[10.5px] text-mist-500 line-through decoration-mist-600"
                >
                  {item}
                </span>
              ))}
            </div>
            <p className="mt-3 text-[10.5px] text-mist-600">
              Shown for transparency — no hidden toggles that do nothing.
            </p>
          </div>

          {/* Assigned tasks */}
          <div className="glass rounded-2xl p-5">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ListTodo size={14} className="text-gild-400" />
                <h2 className="text-sm font-semibold text-mist-100">Assigned tasks</h2>
              </div>
              <Link to={`/tasks${qs({ agentId: agent.id })}`} className="focus-ring text-[11px] font-medium text-[var(--accent)] hover:underline">
                View all
              </Link>
            </div>
            {tasks.length === 0 ? (
              <EmptyState
                compact
                title="No tasks assigned"
                description={`Tasks assigned to ${agent.name} will appear here.`}
                action={
                  <Link to="/tasks" className="focus-ring rounded-lg border border-white/12 px-3.5 py-1.5 text-xs text-mist-300 hover:bg-white/6">
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
      </div>

      {/* Danger-less footer note: agents are profiles in Phase 1 (no deletion to avoid schema drift) */}
      <p className="flex items-center gap-1.5 text-[11px] text-mist-600">
        <Trash2 size={11} className="text-mist-600" />
        Agent profiles are permanent in Phase 1 — their configuration and status remain yours to change.
      </p>
    </div>
  );
}
