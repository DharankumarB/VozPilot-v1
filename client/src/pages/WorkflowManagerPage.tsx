import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  History,
  Pencil,
  Plus,
  Trash2,
  Workflow as WorkflowIcon,
} from 'lucide-react';
import { api } from '../lib/api';
import type { Workflow, WorkflowStatus } from '../lib/types';
import { useToast } from '../context/ToastContext';
import { errorMessage } from '../context/AuthContext';
import { Button } from '../components/ui/Button';
import { Field, Input, Select, Textarea } from '../components/ui/Form';
import { Modal, ConfirmDialog } from '../components/ui/Modal';
import { PageHeader } from '../components/PageHeader';
import { StatusPill, Chip } from '../components/ui/Badge';
import { EmptyState, ListSkeleton } from '../components/ui/Feedback';
import { WORKFLOW_STATUS_META } from '../lib/constants';
import { cn, formatRelative } from '../lib/utils';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

interface StepDraft {
  key: number;
  name: string;
  description: string;
}

interface FormState {
  name: string;
  description: string;
  status: WorkflowStatus;
  steps: StepDraft[];
}

let stepKey = 0;
const nextKey = () => ++stepKey;

const EMPTY_FORM: FormState = { name: '', description: '', status: 'draft', steps: [] };

export function WorkflowManagerPage() {
  useDocumentTitle('Workflow Manager · VozPilot');
  const toast = useToast();

  const [workflows, setWorkflows] = useState<Workflow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Workflow | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<Workflow | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [statusBusy, setStatusBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    api
      .get<Workflow[]>('/api/workflows')
      .then(setWorkflows)
      .catch((caught) => setLoadError(errorMessage(caught)));
  }, []);

  useEffect(load, [load]);

  const openCreate = () => {
    setEditing(null);
    setForm({ ...EMPTY_FORM, steps: [{ key: nextKey(), name: '', description: '' }] });
    setFormError(null);
    setFormOpen(true);
  };

  const openEdit = (workflow: Workflow) => {
    setEditing(workflow);
    setForm({
      name: workflow.name,
      description: workflow.description,
      status: workflow.status,
      steps: workflow.steps.map((step) => ({ key: nextKey(), name: step.name, description: step.description })),
    });
    setFormError(null);
    setFormOpen(true);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const steps = form.steps.filter((step) => step.name.trim());
    if (!form.name.trim()) {
      setFormError('Workflow name is required.');
      return;
    }
    if (steps.length === 0) {
      setFormError('Add at least one step with a name.');
      return;
    }
    setSaving(true);
    setFormError(null);
    const payload = {
      name: form.name.trim(),
      description: form.description.trim(),
      status: form.status,
      steps: steps.map((step, index) => ({
        name: step.name.trim(),
        description: step.description.trim(),
        position: index,
      })),
    };
    try {
      if (editing) {
        await api.patch<Workflow>(`/api/workflows/${editing.id}`, payload);
        toast.success('Workflow updated', payload.name);
      } else {
        await api.post<Workflow>('/api/workflows', payload);
        toast.success('Workflow created', payload.name);
      }
      setFormOpen(false);
      load();
    } catch (caught) {
      setFormError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  const quickStatus = async (workflow: Workflow, status: WorkflowStatus) => {
    if (status === workflow.status) return;
    setStatusBusy(workflow.id);
    try {
      await api.patch<Workflow>(`/api/workflows/${workflow.id}`, { status });
      toast.success('Workflow status updated', `${workflow.name} → ${WORKFLOW_STATUS_META[status].label}`);
      load();
    } catch (caught) {
      toast.error('Could not update workflow', errorMessage(caught));
    } finally {
      setStatusBusy(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    try {
      await api.delete(`/api/workflows/${deleteTarget.id}`);
      toast.success('Workflow deleted', deleteTarget.name);
      setDeleteTarget(null);
      load();
    } catch (caught) {
      toast.error('Could not delete workflow', errorMessage(caught));
    } finally {
      setDeleteBusy(false);
    }
  };

  const moveStep = (index: number, direction: -1 | 1) => {
    setForm((current) => {
      const steps = [...current.steps];
      const target = index + direction;
      if (target < 0 || target >= steps.length) return current;
      [steps[index], steps[target]] = [steps[target], steps[index]];
      return { ...current, steps };
    });
  };

  const toggleExpanded = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="anim-enter flex flex-col gap-6">
      <PageHeader
        title="Workflow Manager"
        subtitle="Design multi-step automations, track their status and review execution history."
        actions={
          <Button variant="primary" icon={<Plus size={15} />} onClick={openCreate}>
            New workflow
          </Button>
        }
      />

      <div className="rounded-2xl border border-dashed border-white/12 bg-white/2 px-4 py-3 text-xs leading-relaxed text-mist-500">
        <strong className="font-semibold text-mist-400">Execution engine:</strong> workflows store
        their definition and status now; run history will be recorded here when execution goes live in
        Phase 2 — no synthetic run records are ever displayed.
      </div>

      {loadError && !workflows ? (
        <EmptyState
          title="Couldn't load workflows"
          description={loadError}
          action={<Button onClick={load}>Retry</Button>}
        />
      ) : !workflows ? (
        <ListSkeleton rows={3} />
      ) : workflows.length === 0 ? (
        <EmptyState
          icon={<WorkflowIcon size={20} />}
          title="No workflows yet"
          description="Compose a workflow from ordered steps — for example: collect input, draft, review, then publish."
          action={
            <Button variant="primary" icon={<Plus size={15} />} onClick={openCreate}>
              Create your first workflow
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {workflows.map((workflow) => {
            const isOpen = expanded.has(workflow.id);
            return (
              <article key={workflow.id} className="glass rounded-2xl">
                <div className="flex items-start justify-between gap-3 p-5">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <h2 className="text-[15px] font-semibold text-mist-100">{workflow.name}</h2>
                      <StatusPill {...WORKFLOW_STATUS_META[workflow.status]} />
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-mist-400">
                      {workflow.description || 'No description yet.'}
                    </p>
                    <p className="mt-2 text-[11px] text-mist-600">
                      {workflow.steps.length} step{workflow.steps.length === 1 ? '' : 's'} · created{' '}
                      {formatRelative(workflow.createdAt)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => openEdit(workflow)}
                      aria-label={`Edit ${workflow.name}`}
                      className="focus-ring rounded-lg p-1.5 text-mist-400 transition hover:bg-white/8 hover:text-mist-100"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteTarget(workflow)}
                      aria-label={`Delete ${workflow.name}`}
                      className="focus-ring rounded-lg p-1.5 text-mist-400 transition hover:bg-rosh-500/12 hover:text-rosh-400"
                    >
                      <Trash2 size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleExpanded(workflow.id)}
                      aria-expanded={isOpen}
                      aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${workflow.name}`}
                      className="focus-ring rounded-lg p-1.5 text-mist-400 transition hover:bg-white/8 hover:text-mist-100"
                    >
                      <ChevronDown size={15} className={cn('transition-transform', isOpen && 'rotate-180')} />
                    </button>
                  </div>
                </div>

                {/* Status control */}
                <div className="flex flex-wrap items-center gap-2 border-t border-white/7 px-5 py-3">
                  <span className="text-[11px] text-mist-500">Status:</span>
                  {(['draft', 'active', 'paused'] as WorkflowStatus[]).map((status) => (
                    <Chip
                      key={status}
                      active={workflow.status === status}
                      onClick={() => void quickStatus(workflow, status)}
                    >
                      {WORKFLOW_STATUS_META[status].label}
                    </Chip>
                  ))}
                  {statusBusy === workflow.id ? <span className="text-[11px] text-mist-600">Saving…</span> : null}
                </div>

                {isOpen ? (
                  <div className="border-t border-white/7 px-5 py-4">
                    {/* Steps */}
                    <p className="micro-label mb-2.5">Steps</p>
                    {workflow.steps.length === 0 ? (
                      <p className="text-xs text-mist-500">No steps defined.</p>
                    ) : (
                      <ol className="flex flex-col gap-2">
                        {workflow.steps.map((step, index) => (
                          <li key={step.id} className="flex items-start gap-3 rounded-xl border border-white/8 bg-white/3 px-3.5 py-2.5">
                            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-[var(--accent-soft)] font-mono text-[10px] font-bold text-[var(--accent)]">
                              {index + 1}
                            </span>
                            <div className="min-w-0">
                              <p className="text-xs font-medium text-mist-200">{step.name}</p>
                              {step.description ? (
                                <p className="mt-0.5 text-[11px] text-mist-500">{step.description}</p>
                              ) : null}
                            </div>
                          </li>
                        ))}
                      </ol>
                    )}

                    {/* Execution history — honest empty state */}
                    <div className="mt-4 rounded-xl border border-dashed border-white/12 px-4 py-3.5">
                      <div className="flex items-center gap-2 text-xs font-semibold text-mist-400">
                        <History size={13} />
                        Execution history
                      </div>
                      <p className="mt-1.5 text-[11.5px] leading-relaxed text-mist-500">
                        No executions recorded yet — the workflow execution engine arrives in Phase 2.
                        {workflow.executions.length === 0 ? ' Nothing has run, and nothing is invented.' : ''}
                      </p>
                    </div>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}

      {/* Create / edit modal */}
      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={editing ? 'Edit workflow' : 'Create workflow'}
        description="Define the ordered steps this workflow should follow."
        size="lg"
        busy={saving}
        footer={
          <>
            <Button variant="ghost" onClick={() => setFormOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" form="workflow-form" loading={saving}>
              {editing ? 'Save changes' : 'Create workflow'}
            </Button>
          </>
        }
      >
        <form id="workflow-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
          {formError ? (
            <div className="rounded-xl border border-rosh-500/30 bg-rosh-500/10 px-3.5 py-2.5 text-xs text-rosh-400" role="alert">
              {formError}
            </div>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor="wf-name">
              <Input
                id="wf-name"
                value={form.name}
                onChange={(event) => setForm((f) => ({ ...f, name: event.target.value }))}
                placeholder="e.g. Weekly client report"
                maxLength={160}
                autoFocus
                required
              />
            </Field>
            <Field label="Status" htmlFor="wf-status">
              <Select
                id="wf-status"
                value={form.status}
                onChange={(event) => setForm((f) => ({ ...f, status: event.target.value as WorkflowStatus }))}
              >
                {(['draft', 'active', 'paused'] as WorkflowStatus[]).map((status) => (
                  <option key={status} value={status}>
                    {WORKFLOW_STATUS_META[status].label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <Field label="Description" htmlFor="wf-desc">
            <Textarea
              id="wf-desc"
              value={form.description}
              onChange={(event) => setForm((f) => ({ ...f, description: event.target.value }))}
              rows={2}
              maxLength={2000}
              placeholder="What does this workflow accomplish?"
            />
          </Field>

          {/* Steps editor */}
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-mist-300">Steps</span>
              <Button
                size="sm"
                icon={<Plus size={13} />}
                onClick={() => setForm((f) => ({ ...f, steps: [...f.steps, { key: nextKey(), name: '', description: '' }] }))}
              >
                Add step
              </Button>
            </div>

            {form.steps.length === 0 ? (
              <p className="rounded-xl border border-dashed border-white/12 px-3.5 py-3 text-xs text-mist-500">
                No steps yet — add at least one.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {form.steps.map((step, index) => (
                  <li key={step.key} className="flex items-start gap-2 rounded-xl border border-white/8 bg-white/3 p-3">
                    <span className="mt-2 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-[var(--accent-soft)] font-mono text-[10px] font-bold text-[var(--accent)]">
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1 space-y-2">
                      <Input
                        value={step.name}
                        onChange={(event) =>
                          setForm((f) => ({
                            ...f,
                            steps: f.steps.map((s) => (s.key === step.key ? { ...s, name: event.target.value } : s)),
                          }))
                        }
                        placeholder={`Step ${index + 1} name`}
                        maxLength={160}
                      />
                      <Input
                        value={step.description}
                        onChange={(event) =>
                          setForm((f) => ({
                            ...f,
                            steps: f.steps.map((s) => (s.key === step.key ? { ...s, description: event.target.value } : s)),
                          }))
                        }
                        placeholder="What happens in this step? (optional)"
                        maxLength={600}
                        className="h-9"
                      />
                    </div>
                    <div className="flex shrink-0 flex-col gap-1">
                      <button
                        type="button"
                        onClick={() => moveStep(index, -1)}
                        disabled={index === 0}
                        aria-label="Move step up"
                        className="focus-ring rounded-md p-1 text-mist-500 transition hover:bg-white/8 hover:text-mist-200 disabled:opacity-30"
                      >
                        <ArrowUp size={13} />
                      </button>
                      <button
                        type="button"
                        onClick={() => moveStep(index, 1)}
                        disabled={index === form.steps.length - 1}
                        aria-label="Move step down"
                        className="focus-ring rounded-md p-1 text-mist-500 transition hover:bg-white/8 hover:text-mist-200 disabled:opacity-30"
                      >
                        <ArrowDown size={13} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setForm((f) => ({ ...f, steps: f.steps.filter((s) => s.key !== step.key) }))}
                        aria-label="Remove step"
                        className="focus-ring rounded-md p-1 text-mist-500 transition hover:bg-rosh-500/12 hover:text-rosh-400"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
        busy={deleteBusy}
        title="Delete workflow?"
        body={`“${deleteTarget?.name ?? ''}” and its ${deleteTarget?.steps.length ?? 0} step(s) will be permanently removed. This cannot be undone.`}
        confirmLabel="Delete workflow"
      />
    </div>
  );
}
