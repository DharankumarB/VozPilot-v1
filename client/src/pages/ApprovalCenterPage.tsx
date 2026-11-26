import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Check, History, ListTodo, ShieldCheck, X } from 'lucide-react';
import { api } from '../lib/api';
import type { Approval } from '../lib/types';
import { useToast } from '../context/ToastContext';
import { errorMessage } from '../context/AuthContext';
import { Button } from '../components/ui/Button';
import { Field, Textarea } from '../components/ui/Form';
import { Modal } from '../components/ui/Modal';
import { PageHeader } from '../components/PageHeader';
import { StatusPill, Chip, Badge } from '../components/ui/Badge';
import { EmptyState, ListSkeleton } from '../components/ui/Feedback';
import { APPROVAL_STATUS_META, TASK_STATUS_META, agentIcon } from '../lib/constants';
import { cn, formatDateTime, formatRelative } from '../lib/utils';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

type Tab = 'pending' | 'history';

export function ApprovalCenterPage() {
  useDocumentTitle('Approval Center · VozPilot');
  const toast = useToast();

  const [tab, setTab] = useState<Tab>('pending');
  const [pending, setPending] = useState<Approval[] | null>(null);
  const [history, setHistory] = useState<Approval[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [rejectTarget, setRejectTarget] = useState<Approval | null>(null);
  const [rejectNote, setRejectNote] = useState('');
  const [rejectBusy, setRejectBusy] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [pendingData, historyData] = await Promise.all([
        api.get<Approval[]>('/api/approvals?status=pending'),
        api.get<Approval[]>('/api/approvals?status=resolved'),
      ]);
      setPending(pendingData);
      setHistory(historyData);
    } catch (caught) {
      setLoadError(errorMessage(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const approve = async (approval: Approval) => {
    setBusyId(approval.id);
    try {
      await api.post<Approval>(`/api/approvals/${approval.id}/resolve`, { decision: 'approve' });
      toast.success('Request approved', `“${approval.title}” authorized.`);
      await load();
    } catch (caught) {
      toast.error('Could not approve', errorMessage(caught));
    } finally {
      setBusyId(null);
    }
  };

  const submitReject = async (event: FormEvent) => {
    event.preventDefault();
    if (!rejectTarget) return;
    setRejectBusy(true);
    try {
      await api.post<Approval>(`/api/approvals/${rejectTarget.id}/resolve`, {
        decision: 'reject',
        note: rejectNote.trim() || undefined,
      });
      toast.success('Request rejected', `“${rejectTarget.title}” rejected.`);
      setRejectTarget(null);
      setRejectNote('');
      await load();
    } catch (caught) {
      toast.error('Could not reject', errorMessage(caught));
    } finally {
      setRejectBusy(false);
    }
  };

  const showPending = tab === 'pending';
  const list = showPending ? pending : history;

  return (
    <div className="anim-enter flex flex-col gap-5">
      <PageHeader
        title="Approval Center"
        subtitle="Human-in-the-loop safety gates — approve or reject external emails, calendar changes, content publications, repository pushes, and gated tasks."
      />

      <div className="flex flex-wrap items-center gap-2">
        <Chip active={tab === 'pending'} onClick={() => setTab('pending')}>
          <ShieldCheck size={12} />
          Pending
          <span className={cn('font-mono', tab === 'pending' ? 'text-[var(--accent)]' : 'text-mist-600')}>
            {pending?.length ?? 0}
          </span>
        </Chip>
        <Chip active={tab === 'history'} onClick={() => setTab('history')}>
          <History size={12} />
          History
          <span className={cn('font-mono', tab === 'history' ? 'text-[var(--accent)]' : 'text-mist-600')}>
            {history?.length ?? 0}
          </span>
        </Chip>
      </div>

      {loadError && !list ? (
        <EmptyState title="Couldn't load approvals" description={loadError} action={<Button onClick={() => void load()}>Retry</Button>} />
      ) : !list ? (
        <ListSkeleton rows={4} />
      ) : list.length === 0 ? (
        <EmptyState
          icon={showPending ? <ShieldCheck size={20} /> : <History size={20} />}
          title={showPending ? 'All caught up' : 'No approval history yet'}
          description={
            showPending
              ? 'Requests appear here when an agent proposes an external side-effect or a task moves to “Waiting for Approval”.'
              : 'Approved and rejected decisions will collect here with timestamps and notes.'
          }
          action={
            showPending ? (
              <Link
                to="/tasks?status=waiting_approval"
                className="focus-ring rounded-lg border border-white/12 px-4 py-2 text-sm text-mist-300 hover:bg-white/6"
              >
                View waiting tasks
              </Link>
            ) : undefined
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          {list.map((approval) => (
            <article key={approval.id} className="glass rounded-2xl p-5">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <StatusPill {...APPROVAL_STATUS_META[approval.status]} />
                    {approval.actionType ? (
                      <Badge className="border border-gild-400/35 bg-gild-500/10 font-mono text-gild-300">
                        {approval.actionType}
                      </Badge>
                    ) : null}
                    <h2 className="text-[15px] font-semibold text-mist-100">{approval.title}</h2>
                  </div>
                  {approval.description ? (
                    <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-mist-400">
                      {approval.description}
                    </p>
                  ) : null}

                  {approval.actionPayload && Object.keys(approval.actionPayload).length > 0 ? (
                    <pre className="mt-2.5 max-h-36 overflow-y-auto whitespace-pre-wrap rounded-xl border border-white/8 bg-black/30 p-3 font-mono text-[11px] text-mist-300">
                      {JSON.stringify(approval.actionPayload, null, 2)}
                    </pre>
                  ) : null}

                  <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11.5px] text-mist-500">
                    {approval.agentName ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="flex h-5 w-5 items-center justify-center rounded border border-white/10 bg-white/5 text-[var(--accent)]">
                          {(() => {
                            const Icon = agentIcon(approval.agentIcon);
                            return <Icon size={10} />;
                          })()}
                        </span>
                        {approval.agentName}
                      </span>
                    ) : null}
                    <span>Requested {formatRelative(approval.requestedAt)}</span>
                    {approval.resolvedAt ? (
                      <span className="text-mist-600">
                        {approval.status === 'approved' ? 'Approved' : approval.status === 'rejected' ? 'Rejected' : 'Dismissed'}{' '}
                        {formatRelative(approval.resolvedAt)}
                      </span>
                    ) : null}
                    {approval.taskTitle ? (
                      <Link
                        to={`/tasks?q=${encodeURIComponent(approval.taskTitle)}`}
                        className="inline-flex items-center gap-1.5 rounded-md bg-white/5 px-2 py-0.5 text-mist-400 transition hover:bg-white/8 hover:text-mist-200"
                      >
                        <ListTodo size={11} />
                        <span className="max-w-56 truncate">{approval.taskTitle}</span>
                        {approval.taskStatus ? (
                          <span className={TASK_STATUS_META[approval.taskStatus as keyof typeof TASK_STATUS_META]?.text}>
                            {TASK_STATUS_META[approval.taskStatus as keyof typeof TASK_STATUS_META]?.label}
                          </span>
                        ) : null}
                      </Link>
                    ) : null}
                  </div>

                  {approval.resolutionNote ? (
                    <p className="mt-3 rounded-xl border border-white/8 bg-white/3 px-3.5 py-2.5 text-xs text-mist-400">
                      <span className="font-medium text-mist-300">Note: </span>
                      {approval.resolutionNote}
                    </p>
                  ) : null}

                  {approval.executionResult ? (
                    <p className="mt-2 rounded-xl border border-azure-400/25 bg-azure-500/8 px-3.5 py-2 font-mono text-[11px] text-azure-400">
                      Action outcome: {JSON.stringify(approval.executionResult)}
                    </p>
                  ) : null}
                </div>

                {approval.status === 'pending' ? (
                  <div className="flex shrink-0 gap-2">
                    <Button
                      variant="danger"
                      size="md"
                      icon={<X size={14} />}
                      loading={busyId === approval.id}
                      onClick={() => {
                        setRejectTarget(approval);
                        setRejectNote('');
                      }}
                    >
                      Reject
                    </Button>
                    <Button
                      variant="primary"
                      size="md"
                      icon={<Check size={14} />}
                      loading={busyId === approval.id}
                      onClick={() => void approve(approval)}
                    >
                      Approve
                    </Button>
                  </div>
                ) : (
                  <span className="shrink-0 text-[11px] text-mist-600" title={formatDateTime(approval.resolvedAt ?? approval.requestedAt)}>
                    {formatRelative(approval.resolvedAt ?? approval.requestedAt)}
                  </span>
                )}
              </div>
            </article>
          ))}
        </div>
      )}

      {/* Reject dialog with optional note */}
      <Modal
        open={rejectTarget !== null}
        onClose={() => setRejectTarget(null)}
        title="Reject request?"
        description={`“${rejectTarget?.title ?? ''}” will be rejected and recorded in history.`}
        size="sm"
        busy={rejectBusy}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRejectTarget(null)} disabled={rejectBusy}>
              Cancel
            </Button>
            <Button variant="danger" type="submit" form="reject-form" loading={rejectBusy}>
              Reject request
            </Button>
          </>
        }
      >
        <form id="reject-form" onSubmit={submitReject}>
          <Field label="Reason (optional)" htmlFor="reject-note" hint="Stored with the decision so history stays useful.">
            <Textarea
              id="reject-note"
              value={rejectNote}
              onChange={(event) => setRejectNote(event.target.value)}
              rows={3}
              maxLength={500}
              placeholder="e.g. Scope needs another pass before execution"
              autoFocus
            />
          </Field>
        </form>
      </Modal>
    </div>
  );
}
