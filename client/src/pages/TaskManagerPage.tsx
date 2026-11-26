import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Check,
  Filter,
  ListTodo,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { api, qs } from '../lib/api';
import type { Agent, StatusCounts, Task, TaskPriority, TaskStatus } from '../lib/types';
import { useToast } from '../context/ToastContext';
import { errorMessage } from '../context/AuthContext';
import { useAuth } from '../context/AuthContext';
import { Button } from '../components/ui/Button';
import { Field, Input, Select, Textarea } from '../components/ui/Form';
import { Modal, ConfirmDialog } from '../components/ui/Modal';
import { PageHeader } from '../components/PageHeader';
import { StatusPill, Chip } from '../components/ui/Badge';
import { EmptyState, ListSkeleton } from '../components/ui/Feedback';
import {
  PRIORITY_META,
  TASK_STATUS_META,
  TASK_STATUS_ORDER,
  agentIcon,
} from '../lib/constants';
import { cn, formatDueDate, formatRelative } from '../lib/utils';
import { useDebouncedValue } from '../hooks/useDebounce';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

interface TaskFilters {
  status: TaskStatus | 'all';
  priority: TaskPriority | 'all';
  agentId: string;
  sort: string;
}

const DEFAULT_FILTERS: TaskFilters = {
  status: 'all',
  priority: 'all',
  agentId: 'all',
  sort: 'created_desc',
};

interface FormState {
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: string;
  agentId: string;
}

const EMPTY_FORM: FormState = {
  title: '',
  description: '',
  status: 'pending',
  priority: 'medium',
  dueDate: '',
  agentId: '',
};

export function TaskManagerPage() {
  useDocumentTitle('Task Manager · VozPilot');
  const toast = useToast();
  const { preferences } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [counts, setCounts] = useState<StatusCounts | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [search, setSearch] = useState(searchParams.get('q') ?? '');
  const debouncedSearch = useDebouncedValue(search, 300);
  const [filters, setFilters] = useState<TaskFilters>({
    ...DEFAULT_FILTERS,
    status: (searchParams.get('status') as TaskStatus | null) ?? 'all',
    priority: (searchParams.get('priority') as TaskPriority | null) ?? 'all',
    sort: searchParams.get('sort') ?? 'created_desc',
    agentId: searchParams.get('agentId') ?? 'all',
  });

  // Modal state
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Task | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [statusBusy, setStatusBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const query = qs({
        q: debouncedSearch.trim() || undefined,
        status: filters.status,
        priority: filters.priority,
        agentId: filters.agentId,
        sort: filters.sort,
      });
      const [taskResult, agentList] = await Promise.all([
        api.get<{ tasks: Task[]; counts: StatusCounts }>(`/api/tasks${query}`),
        agents.length === 0 ? api.get<Agent[]>('/api/agents') : Promise.resolve(agents),
      ]);
      setTasks(taskResult.tasks);
      setCounts(taskResult.counts);
      setAgents(agentList);
    } catch (caught) {
      setLoadError(errorMessage(caught));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, filters.status, filters.priority, filters.agentId, filters.sort]);

  useEffect(() => {
    void load();
  }, [load]);

  // Keep URL shareable for search/filter/sort.
  useEffect(() => {
    const next = qs({
      q: debouncedSearch.trim() || undefined,
      status: filters.status === 'all' ? undefined : filters.status,
      priority: filters.priority === 'all' ? undefined : filters.priority,
      agentId: filters.agentId === 'all' ? undefined : filters.agentId,
      sort: filters.sort === 'created_desc' ? undefined : filters.sort,
    });
    setSearchParams(next ? new URLSearchParams(next) : new URLSearchParams(), { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, filters]);

  const openCreate = () => {
    setEditing(null);
    const defaults = preferences.agentDefaults;
    setForm({
      ...EMPTY_FORM,
      priority: defaults?.defaultPriority ?? 'medium',
      agentId: defaults?.defaultAgentId ?? '',
    });
    setFormError(null);
    setFormOpen(true);
  };

  const openEdit = (task: Task) => {
    setEditing(task);
    setForm({
      title: task.title,
      description: task.description,
      status: task.status,
      priority: task.priority,
      dueDate: task.dueDate ?? '',
      agentId: task.agentId ?? '',
    });
    setFormError(null);
    setFormOpen(true);
  };

  const submitForm = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.title.trim()) {
      setFormError('Title is required.');
      return;
    }
    setSaving(true);
    setFormError(null);
    const payload = {
      title: form.title.trim(),
      description: form.description.trim(),
      status: form.status,
      priority: form.priority,
      dueDate: form.dueDate || null,
      agentId: form.agentId || null,
    };
    try {
      if (editing) {
        await api.patch<Task>(`/api/tasks/${editing.id}`, payload);
        toast.success('Task updated', payload.title);
      } else {
        await api.post<Task>('/api/tasks', payload);
        toast.success('Task created', payload.title);
      }
      setFormOpen(false);
      await load();
    } catch (caught) {
      setFormError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    try {
      await api.delete(`/api/tasks/${deleteTarget.id}`);
      toast.success('Task deleted', deleteTarget.title);
      setDeleteTarget(null);
      await load();
    } catch (caught) {
      toast.error('Could not delete task', errorMessage(caught));
    } finally {
      setDeleteBusy(false);
    }
  };

  const quickStatus = async (task: Task, status: TaskStatus) => {
    if (status === task.status) return;
    setStatusBusy(task.id);
    try {
      await api.patch<Task>(`/api/tasks/${task.id}`, { status });
      if (status === 'waiting_approval') {
        toast.info('Approval requested', `“${task.title}” is waiting in the Approval Center.`);
      } else if (status === 'completed') {
        toast.success('Task completed', task.title);
      } else {
        toast.success('Status updated', `“${task.title}” → ${TASK_STATUS_META[status].label}`);
      }
      await load();
    } catch (caught) {
      toast.error('Could not update status', errorMessage(caught));
    } finally {
      setStatusBusy(null);
    }
  };

  const hasFilters =
    filters.status !== 'all' || filters.priority !== 'all' || filters.agentId !== 'all' || search.trim() !== '';

  const chipCounts = useMemo(() => counts ?? null, [counts]);

  return (
    <div className="anim-enter flex flex-col gap-5">
      <PageHeader
        title="Task Manager"
        subtitle="Create, assign, prioritise and gate work — everything persists in PostgreSQL."
        actions={
          <Button variant="primary" icon={<Plus size={15} />} onClick={openCreate}>
            New task
          </Button>
        }
      />

      {/* Status chips */}
      {chipCounts ? (
        <div className="flex flex-wrap gap-2">
          <Chip active={filters.status === 'all'} onClick={() => setFilters((f) => ({ ...f, status: 'all' }))}>
            All <span className={cn('font-mono', filters.status === 'all' ? 'text-[var(--accent)]' : 'text-mist-600')}>{chipCounts.all}</span>
          </Chip>
          {TASK_STATUS_ORDER.map((status) => (
            <Chip
              key={status}
              active={filters.status === status}
              onClick={() => setFilters((f) => ({ ...f, status }))}
            >
              {TASK_STATUS_META[status].label}
              <span className={cn('font-mono', filters.status === status ? 'text-[var(--accent)]' : 'text-mist-600')}>
                {chipCounts[status]}
              </span>
            </Chip>
          ))}
        </div>
      ) : null}

      {/* Toolbar */}
      <div className="glass flex flex-wrap items-center gap-2.5 rounded-2xl p-3">
        <div className="relative min-w-52 flex-1">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-mist-500" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by title or description…"
            aria-label="Search tasks"
            className="focus-ring h-9 w-full rounded-xl border border-white/10 bg-void-900/70 pl-9 pr-3 text-sm text-mist-100 placeholder:text-mist-500 focus:border-[var(--accent)]"
          />
        </div>

        <div className="w-40">
          <Select
            aria-label="Filter by priority"
            value={filters.priority}
            onChange={(event) => setFilters((f) => ({ ...f, priority: event.target.value as TaskPriority | 'all' }))}
            className="h-9"
          >
            <option value="all">All priorities</option>
            {(['critical', 'high', 'medium', 'low'] as TaskPriority[]).map((priority) => (
              <option key={priority} value={priority}>
                {PRIORITY_META[priority].label}
              </option>
            ))}
          </Select>
        </div>

        <div className="w-44">
          <Select
            aria-label="Filter by agent"
            value={filters.agentId}
            onChange={(event) => setFilters((f) => ({ ...f, agentId: event.target.value }))}
            className="h-9"
          >
            <option value="all">All agents</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </Select>
        </div>

        <div className="w-44">
          <Select
            aria-label="Sort tasks"
            value={filters.sort}
            onChange={(event) => setFilters((f) => ({ ...f, sort: event.target.value }))}
            className="h-9"
          >
            <option value="created_desc">Newest first</option>
            <option value="updated_desc">Recently updated</option>
            <option value="due_asc">Due date</option>
            <option value="priority_desc">Priority</option>
          </Select>
        </div>

        {hasFilters ? (
          <Button
            size="sm"
            variant="ghost"
            icon={<X size={13} />}
            onClick={() => {
              setSearch('');
              setFilters(DEFAULT_FILTERS);
            }}
          >
            Clear
          </Button>
        ) : (
          <span className="hidden items-center gap-1.5 px-1 text-[11px] text-mist-600 sm:flex">
            <Filter size={11} /> {tasks?.length ?? 0} shown
          </span>
        )}
      </div>

      {/* Content */}
      {loadError && !tasks ? (
        <EmptyState
          title="Couldn't load tasks"
          description={loadError}
          action={<Button onClick={() => void load()}>Retry</Button>}
        />
      ) : !tasks ? (
        <ListSkeleton rows={6} />
      ) : tasks.length === 0 ? (
        <EmptyState
          icon={<ListTodo size={20} />}
          title={hasFilters ? 'No tasks match these filters' : 'No tasks yet'}
          description={
            hasFilters
              ? 'Adjust your search or filters to see more work.'
              : 'Create your first task, assign an agent and track it to completion.'
          }
          action={
            hasFilters ? (
              <Button
                onClick={() => {
                  setSearch('');
                  setFilters(DEFAULT_FILTERS);
                }}
              >
                Clear filters
              </Button>
            ) : (
              <Button variant="primary" icon={<Plus size={15} />} onClick={openCreate}>
                Create first task
              </Button>
            )
          }
        />
      ) : (
        <>
          {/* Desktop table */}
          <div className="glass hidden overflow-hidden rounded-2xl md:block">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-white/8 text-[11px] uppercase tracking-[0.1em] text-mist-500">
                  <th className="px-5 py-3 font-semibold">Task</th>
                  <th className="px-3 py-3 font-semibold">Agent</th>
                  <th className="px-3 py-3 font-semibold">Status</th>
                  <th className="px-3 py-3 font-semibold">Priority</th>
                  <th className="px-3 py-3 font-semibold">Due</th>
                  <th className="px-3 py-3 font-semibold">Updated</th>
                  <th className="px-5 py-3 text-right font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/6">
                {tasks.map((task) => {
                  const due = formatDueDate(task.dueDate);
                  const priority = PRIORITY_META[task.priority];
                  const AgentIcon = agentIcon(task.agentIcon);
                  return (
                    <tr key={task.id} className="group transition hover:bg-white/3">
                      <td className="max-w-72 px-5 py-3.5">
                        <p className={cn('truncate font-medium text-mist-100', task.status === 'completed' && 'text-mist-400 line-through decoration-mist-600')}>
                          {task.title}
                        </p>
                        {task.description ? (
                          <p className="mt-0.5 truncate text-xs text-mist-500">{task.description}</p>
                        ) : null}
                      </td>
                      <td className="px-3 py-3.5">
                        {task.agentId ? (
                          <span className="inline-flex items-center gap-2 text-xs text-mist-300">
                            <span className="flex h-6 w-6 items-center justify-center rounded-md border border-white/10 bg-white/5 text-[var(--accent)]">
                              <AgentIcon size={12} />
                            </span>
                            {task.agentName}
                          </span>
                        ) : (
                          <span className="text-xs text-mist-600">Unassigned</span>
                        )}
                      </td>
                      <td className="px-3 py-3.5">
                        <div className="relative">
                          <select
                            value={task.status}
                            disabled={statusBusy === task.id}
                            onChange={(event) => void quickStatus(task, event.target.value as TaskStatus)}
                            aria-label={`Status of ${task.title}`}
                            className={cn(
                              'focus-ring h-8 cursor-pointer appearance-none rounded-lg border border-transparent bg-transparent pl-3 pr-7 text-xs font-medium transition hover:border-white/12 disabled:opacity-50',
                              TASK_STATUS_META[task.status].text,
                              TASK_STATUS_META[task.status].bg,
                            )}
                            style={{ backgroundImage: 'none' }}
                          >
                            {TASK_STATUS_ORDER.map((status) => (
                              <option key={status} value={status} className="bg-void-850 text-mist-200">
                                {TASK_STATUS_META[status].label}
                              </option>
                            ))}
                          </select>
                          <svg viewBox="0 0 12 12" aria-hidden="true" className="pointer-events-none absolute right-2 top-1/2 h-2.5 w-2.5 -translate-y-1/2 fill-none stroke-current" strokeWidth="1.6" strokeLinecap="round">
                            <path d="M2.5 4.5 6 8l3.5-3.5" />
                          </svg>
                        </div>
                      </td>
                      <td className="px-3 py-3.5">
                        <span className={cn('inline-flex items-center gap-1.5 text-xs', priority.text)}>
                          <span className={cn('h-1.5 w-1.5 rounded-full', priority.dot)} />
                          {priority.label}
                        </span>
                      </td>
                      <td className="px-3 py-3.5">
                        <span
                          className={cn(
                            'text-xs',
                            due.tone === 'overdue' && 'font-medium text-rosh-400',
                            due.tone === 'today' && 'font-medium text-gild-400',
                            due.tone === 'none' && 'text-mist-600',
                            (due.tone === 'later' || due.tone === 'soon') && 'text-mist-400',
                          )}
                          title={task.dueDate ?? 'No due date'}
                        >
                          {due.label}
                        </span>
                      </td>
                      <td className="px-3 py-3.5 text-xs text-mist-500" title={task.updatedAt}>
                        {formatRelative(task.updatedAt)}
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="flex items-center justify-end gap-1 opacity-60 transition group-hover:opacity-100">
                          <button
                            type="button"
                            onClick={() => openEdit(task)}
                            aria-label={`Edit ${task.title}`}
                            className="focus-ring rounded-lg p-1.5 text-mist-400 transition hover:bg-white/8 hover:text-mist-100"
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeleteTarget(task)}
                            aria-label={`Delete ${task.title}`}
                            className="focus-ring rounded-lg p-1.5 text-mist-400 transition hover:bg-rosh-500/12 hover:text-rosh-400"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="flex flex-col gap-3 md:hidden">
            {tasks.map((task) => {
              const due = formatDueDate(task.dueDate);
              const priority = PRIORITY_META[task.priority];
              return (
                <div key={task.id} className="glass rounded-2xl p-4">
                  <div className="flex items-start justify-between gap-3">
                    <p className={cn('text-sm font-medium text-mist-100', task.status === 'completed' && 'text-mist-400 line-through')}>
                      {task.title}
                    </p>
                    <span className={cn('inline-flex shrink-0 items-center gap-1 text-[11px]', priority.text)}>
                      <span className={cn('h-1.5 w-1.5 rounded-full', priority.dot)} />
                      {priority.label}
                    </span>
                  </div>
                  {task.description ? <p className="mt-1 text-xs text-mist-500">{task.description}</p> : null}
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-mist-500">
                    <StatusPill {...TASK_STATUS_META[task.status]} />
                    <span>{task.agentName ?? 'Unassigned'}</span>
                    <span className={cn(due.tone === 'overdue' && 'text-rosh-400', due.tone === 'today' && 'text-gild-400')}>
                      {due.label}
                    </span>
                  </div>
                  <div className="mt-3 flex items-center justify-between border-t border-white/7 pt-3">
                    <span className="text-[11px] text-mist-600">{formatRelative(task.updatedAt)}</span>
                    <div className="flex gap-1">
                      <Button size="sm" variant="ghost" icon={<Pencil size={13} />} onClick={() => openEdit(task)}>
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={() => setDeleteTarget(task)}>
                        Delete
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Create / edit modal */}
      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={editing ? 'Edit task' : 'Create task'}
        description={editing ? 'Update details, assignment or status.' : 'Add work to your queue and optionally assign an agent.'}
        busy={saving}
        footer={
          <>
            <Button variant="ghost" onClick={() => setFormOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button variant="primary" form="task-form" type="submit" loading={saving}>
              {editing ? 'Save changes' : 'Create task'}
            </Button>
          </>
        }
      >
        <form id="task-form" onSubmit={submitForm} className="flex flex-col gap-4" noValidate>
          {formError ? (
            <div className="rounded-xl border border-rosh-500/30 bg-rosh-500/10 px-3.5 py-2.5 text-xs text-rosh-400" role="alert">
              {formError}
            </div>
          ) : null}

          <Field label="Title" htmlFor="task-title" error={!form.title.trim() && formError ? 'Title is required.' : undefined}>
            <Input
              id="task-title"
              value={form.title}
              onChange={(event) => setForm((f) => ({ ...f, title: event.target.value }))}
              placeholder="e.g. Prepare Q1 investor update"
              maxLength={200}
              autoFocus
              required
            />
          </Field>

          <Field label="Description" htmlFor="task-desc" hint="Optional context for whoever picks this up.">
            <Textarea
              id="task-desc"
              value={form.description}
              onChange={(event) => setForm((f) => ({ ...f, description: event.target.value }))}
              rows={3}
              maxLength={4000}
              placeholder="What needs to happen, and what does done look like?"
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Assign agent" htmlFor="task-agent">
              <Select id="task-agent" value={form.agentId} onChange={(event) => setForm((f) => ({ ...f, agentId: event.target.value }))}>
                <option value="">Unassigned</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Priority" htmlFor="task-priority">
              <Select
                id="task-priority"
                value={form.priority}
                onChange={(event) => setForm((f) => ({ ...f, priority: event.target.value as TaskPriority }))}
              >
                {(['low', 'medium', 'high', 'critical'] as TaskPriority[]).map((priority) => (
                  <option key={priority} value={priority}>
                    {PRIORITY_META[priority].label}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Status" htmlFor="task-status">
              <Select
                id="task-status"
                value={form.status}
                onChange={(event) => setForm((f) => ({ ...f, status: event.target.value as TaskStatus }))}
              >
                {TASK_STATUS_ORDER.map((status) => (
                  <option key={status} value={status}>
                    {TASK_STATUS_META[status].label}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Due date" htmlFor="task-due" hint="Stored as a calendar date.">
              <Input
                id="task-due"
                type="date"
                value={form.dueDate}
                onChange={(event) => setForm((f) => ({ ...f, dueDate: event.target.value }))}
              />
            </Field>
          </div>

          {form.status === 'waiting_approval' ? (
            <div className="flex items-start gap-2.5 rounded-xl border border-gild-500/30 bg-gild-500/8 px-3.5 py-2.5 text-xs text-gild-400/90">
              <Check size={14} className="mt-0.5 shrink-0" />
              An approval request will be created in the Approval Center the moment you save.
            </div>
          ) : null}
        </form>
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
        busy={deleteBusy}
        title="Delete task?"
        body={`“${deleteTarget?.title ?? ''}” will be permanently removed, along with any pending approval request linked to it. This cannot be undone.`}
        confirmLabel="Delete task"
      />
    </div>
  );
}
