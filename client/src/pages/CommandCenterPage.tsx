import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  Check,
  MessageSquare,
  Paperclip,
  Plus,
  RefreshCw,
  Send,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { ApiError, api } from '../lib/api';
import type { Conversation, Message, Task } from '../lib/types';
import {
  isLiveStatus,
  vozcore,
  type ExecutionDetail,
  type VozCoreHealth,
} from '../lib/vozcore';
import { useToast } from '../context/ToastContext';
import { errorMessage } from '../context/AuthContext';
import { Button } from '../components/ui/Button';
import { Modal, ConfirmDialog } from '../components/ui/Modal';
import { EmptyState, Spinner } from '../components/ui/Feedback';
import { StatusPill } from '../components/ui/Badge';
import { ExecutionPanel } from '../components/execution/ExecutionPanel';
import { TASK_STATUS_META } from '../lib/constants';
import { cn, formatDateTime, formatRelative } from '../lib/utils';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

const SUGGESTIONS = [
  'Summarise the biggest risks across my open projects',
  'Draft a reply to the latest client email',
  'Plan next week around my existing deadlines',
];

type EngineState = { kind: 'loading' } | { kind: 'offline' } | { kind: 'ready'; health: VozCoreHealth };

function engineBadge(state: EngineState) {
  if (state.kind === 'loading') {
    return { dot: 'bg-mist-500', text: 'text-mist-500', label: 'Engine…', pulse: false };
  }
  if (state.kind === 'offline') {
    return { dot: 'bg-rosh-500', text: 'text-rosh-400', label: 'Engine offline', pulse: false };
  }
  if (state.health.llm.configured) {
    return { dot: 'bg-verdant-500', text: 'text-verdant-400', label: `VozCore online · ${state.health.llm.model ?? 'model set'}`, pulse: true };
  }
  return { dot: 'bg-gild-500', text: 'text-gild-400', label: 'Engine ready · API key needed', pulse: false };
}

/**
 * AI Command Center — Phase 2: commands run through the real VozCore
 * orchestration engine (intent → plan → agents → evaluation → response).
 * Nothing is simulated: without credentials the UI shows the configuration
 * message returned by the engine.
 */
export function CommandCenterPage() {
  useDocumentTitle('AI Command Center · VozPilot');
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const draftParam = searchParams.get('draft');

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingThread, setLoadingThread] = useState(false);
  const [sending, setSending] = useState(false);
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Task[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [attachable, setAttachable] = useState<Task[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<Conversation | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // VozCore engine state
  const [engine, setEngine] = useState<EngineState>({ kind: 'loading' });
  const [execution, setExecution] = useState<ExecutionDetail | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [commandError, setCommandError] = useState<{
    message: string;
    conversationId: string;
    sourceMessageId: string;
    command: string;
  } | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  const cursorRef = useRef(0);

  const loadHealth = useCallback(async () => {
    try {
      const health = await vozcore.health();
      setEngine({ kind: 'ready', health });
    } catch (caught) {
      if (caught instanceof ApiError && (caught.status === 503 || caught.status === 0)) {
        setEngine({ kind: 'offline' });
      } else if (caught instanceof ApiError && caught.status === 401) {
        setEngine({ kind: 'offline' });
      } else {
        setEngine({ kind: 'offline' });
      }
    }
  }, []);

  const loadConversations = useCallback(async () => {
    try {
      const list = await api.get<Conversation[]>('/api/conversations');
      setConversations(list);
      return list;
    } catch (caught) {
      toast.error('Could not load conversations', errorMessage(caught));
      return [];
    } finally {
      setLoadingList(false);
    }
  }, [toast]);

  const loadExecutionFor = useCallback(async (conversationId: string) => {
    try {
      const list = await vozcore.list(conversationId);
      const latest = list[0];
      if (!latest) {
        setExecution(null);
        cursorRef.current = 0;
        return;
      }
      const detail = await vozcore.detail(latest.id, 0);
      cursorRef.current = detail.lastEventId;
      setExecution(detail);
    } catch {
      setExecution(null);
    }
  }, []);

  const openConversation = useCallback(
    async (id: string) => {
      setActiveId(id);
      setLoadingThread(true);
      setCommandError(null);
      try {
        const data = await api.get<{ conversation: Conversation; messages: Message[] }>(`/api/conversations/${id}`);
        setMessages(data.messages);
        await loadExecutionFor(id);
      } catch (caught) {
        toast.error('Could not open conversation', errorMessage(caught));
      } finally {
        setLoadingThread(false);
      }
    },
    [toast, loadExecutionFor],
  );

  // Boot: health + conversations; honour ?draft= from the Overview quick command.
  useEffect(() => {
    void loadHealth();
    void (async () => {
      const list = await loadConversations();
      if (draftParam) {
        setText(draftParam);
        if (list.length > 0) {
          await openConversation(list[0].id);
        }
        setSearchParams({}, { replace: true });
      } else if (list.length > 0) {
        await openConversation(list[0].id);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll a live execution; on completion pick up the assistant reply.
  const executionId = execution?.execution.id;
  const executionStatus = execution?.execution.status;
  useEffect(() => {
    if (!executionId || !executionStatus || !isLiveStatus(executionStatus)) return;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const fresh = await vozcore.detail(executionId, cursorRef.current);
          cursorRef.current = fresh.lastEventId;
          setExecution((previous) => {
            if (!previous) return fresh;
            const seen = new Set(previous.events.map((event) => event.id));
            const merged = [...previous.events, ...fresh.events.filter((event) => !seen.has(event.id))];
            return { ...fresh, events: merged };
          });
          if (!isLiveStatus(fresh.execution.status)) {
            const conversationId = activeIdRef.current;
            if (conversationId) {
              const data = await api.get<{ conversation: Conversation; messages: Message[] }>(
                `/api/conversations/${conversationId}`,
              );
              setMessages(data.messages);
            }
          }
        } catch {
          /* transient poll failure — next tick retries */
        }
      })();
    }, 900);
    return () => window.clearInterval(timer);
  }, [executionId, executionStatus]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, loadingThread, execution?.events.length, execution?.execution.status]);

  const startNewConversation = async () => {
    try {
      const conversation = await api.post<Conversation>('/api/conversations', {});
      setConversations((current) => [conversation, ...current]);
      setActiveId(conversation.id);
      setMessages([]);
      setText('');
      setAttachments([]);
      setExecution(null);
      setCommandError(null);
      cursorRef.current = 0;
    } catch (caught) {
      toast.error('Could not start conversation', errorMessage(caught));
    }
  };

  const openPicker = async () => {
    setPicked(new Set(attachments.map((task) => task.id)));
    setPickerOpen(true);
    if (attachable.length === 0) {
      try {
        const tasks = await api.get<Task[]>('/api/conversations/tasks/attachable');
        setAttachable(tasks);
      } catch (caught) {
        toast.error('Could not load tasks', errorMessage(caught));
      }
    }
  };

  const confirmPicker = () => {
    setAttachments(attachable.filter((task) => picked.has(task.id)));
    setPickerOpen(false);
  };

  /** Hand an already-persisted message to the VozCore engine. */
  const dispatchToVozCore = async (conversationId: string, sourceMessageId: string, command: string) => {
    setCommandError(null);
    try {
      const started = await vozcore.start({ command, conversationId, sourceMessageId });
      const detail = await vozcore.detail(started.execution.id, 0);
      cursorRef.current = detail.lastEventId;
      setExecution(detail);
    } catch (caught) {
      const message =
        caught instanceof ApiError
          ? caught.message
          : 'Could not reach the VozCore engine. Is it running? (npm run vozcore)';
      setCommandError({ message, conversationId, sourceMessageId, command });
    }
  };

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const content = text.trim();
    if (!content) return;

    let conversationId = activeId;
    if (!conversationId) {
      try {
        const conversation = await api.post<Conversation>('/api/conversations', {});
        setConversations((current) => [conversation, ...current]);
        setActiveId(conversation.id);
        conversationId = conversation.id;
      } catch (caught) {
        toast.error('Could not start conversation', errorMessage(caught));
        return;
      }
    }

    setSending(true);
    try {
      const result = await api.post<{ conversation: Conversation; message: Message }>(
        `/api/conversations/${conversationId}/messages`,
        { content, attachmentTaskIds: attachments.map((task) => task.id) },
      );
      setMessages((current) => [...current, result.message]);
      setText('');
      setAttachments([]);
      setConversations((current) => {
        const rest = current.filter((item) => item.id !== result.conversation.id);
        return [
          {
            ...result.conversation,
            messageCount: (current.find((c) => c.id === result.conversation.id)?.messageCount ?? 0) + 1,
          },
          ...rest,
        ];
      });
      await dispatchToVozCore(conversationId, result.message.id, content);
    } catch (caught) {
      toast.error('Message not sent', errorMessage(caught));
    } finally {
      setSending(false);
    }
  };

  const retryCommand = async () => {
    if (!commandError) return;
    setSending(true);
    await dispatchToVozCore(commandError.conversationId, commandError.sourceMessageId, commandError.command);
    setSending(false);
  };

  const cancelExecution = async (executionIdToCancel: string) => {
    setCancelling(true);
    try {
      const result = await vozcore.cancel(executionIdToCancel);
      setExecution((previous) =>
        previous ? { ...previous, execution: result.execution } : previous,
      );
      toast.success('Cancellation requested', 'The engine stops at the next safe point.');
    } catch (caught) {
      toast.error('Could not cancel', errorMessage(caught));
    } finally {
      setCancelling(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    try {
      await api.delete(`/api/conversations/${deleteTarget.id}`);
      setConversations((current) => current.filter((item) => item.id !== deleteTarget.id));
      if (activeId === deleteTarget.id) {
        setActiveId(null);
        setMessages([]);
        setExecution(null);
        setCommandError(null);
      }
      setDeleteTarget(null);
      toast.success('Conversation deleted');
    } catch (caught) {
      toast.error('Could not delete conversation', errorMessage(caught));
    } finally {
      setDeleteBusy(false);
    }
  };

  const activeConversation = conversations.find((item) => item.id === activeId) ?? null;
  const hasThread = Boolean(activeId);
  const badge = engineBadge(engine);
  const unconfigured = engine.kind === 'ready' && !engine.health.llm.configured;

  return (
    <div className="anim-enter">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-mist-100 sm:text-2xl">AI Command Center</h1>
          <p className="mt-1 text-sm text-mist-400">
            {engine.kind === 'ready' && engine.health.llm.configured
              ? 'Talk to VozCore — real intent analysis, planning and agent orchestration on every command.'
              : 'Talk to VozCore — commands are planned and dispatched by the orchestration engine.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'hidden items-center gap-1.5 rounded-full border border-white/10 bg-white/4 px-3 py-1 text-[11px] font-medium sm:inline-flex',
              badge.text,
            )}
            title={engine.kind === 'ready' ? engine.health.message ?? 'VozCore engine' : 'VozCore engine'}
          >
            <span className={cn('h-1.5 w-1.5 rounded-full', badge.dot, badge.pulse && 'animate-pulse')} />
            {badge.label}
          </span>
          <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={() => void startNewConversation()}>
            New conversation
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        {/* Conversation list */}
        <aside className="glass hidden max-h-[calc(100dvh-14rem)] flex-col overflow-hidden rounded-2xl lg:flex">
          <div className="border-b border-white/7 px-4 py-3">
            <p className="micro-label">History</p>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {loadingList ? (
              <div className="flex justify-center py-6">
                <Spinner />
              </div>
            ) : conversations.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs leading-relaxed text-mist-500">
                No conversations yet. Start one to record your first command.
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {conversations.map((conversation) => (
                  <li key={conversation.id} className="group relative">
                    <button
                      type="button"
                      onClick={() => void openConversation(conversation.id)}
                      className={cn(
                        'focus-ring w-full rounded-xl px-3 py-2.5 pr-8 text-left transition',
                        conversation.id === activeId ? 'bg-[var(--accent-soft)]' : 'hover:bg-white/5',
                      )}
                    >
                      <span className="block truncate text-xs font-medium text-mist-200">{conversation.title}</span>
                      <span className="mt-0.5 block text-[10.5px] text-mist-500">
                        {conversation.messageCount} message{conversation.messageCount === 1 ? '' : 's'} ·{' '}
                        {formatRelative(conversation.updatedAt)}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteTarget(conversation)}
                      aria-label={`Delete ${conversation.title}`}
                      className="absolute right-1.5 top-1/2 hidden -translate-y-1/2 rounded-lg p-1.5 text-mist-500 transition hover:bg-rosh-500/15 hover:text-rosh-400 group-hover:block focus-ring"
                    >
                      <Trash2 size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>

        {/* Thread */}
        <section className="glass flex min-h-[calc(100dvh-14rem)] flex-col overflow-hidden rounded-2xl">
          {/* Thread header */}
          <div className="flex items-center justify-between gap-3 border-b border-white/7 px-5 py-3.5">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--accent)]/30 bg-[var(--accent-faint)] text-[var(--accent)]">
                <Sparkles size={15} />
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-mist-100">
                  {activeConversation?.title ?? 'VozCore'}
                </p>
                <p className="text-[11px] text-mist-500">
                  Central AI manager · plans, delegates and evaluates with specialist agents
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/4 px-2.5 py-1 text-[10.5px]',
                  badge.text,
                )}
              >
                <span className={cn('h-1.5 w-1.5 rounded-full', badge.dot, badge.pulse && 'animate-pulse')} />
                {badge.label}
              </span>
              {deleteTarget === null && activeId ? (
                <button
                  type="button"
                  onClick={() => activeConversation && setDeleteTarget(activeConversation)}
                  aria-label="Delete conversation"
                  className="focus-ring rounded-lg p-1.5 text-mist-500 transition hover:bg-rosh-500/10 hover:text-rosh-400"
                >
                  <Trash2 size={14} />
                </button>
              ) : null}
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-5 sm:px-6">
            {!hasThread ? (
              <div className="flex h-full flex-col items-center justify-center gap-5">
                <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/4 text-[var(--accent)]">
                  <MessageSquare size={24} />
                </span>
                <div className="text-center">
                  <h2 className="text-base font-semibold text-mist-100">Start commanding your workforce</h2>
                  <p className="mx-auto mt-1.5 max-w-md text-xs leading-relaxed text-mist-500">
                    Every message is saved to your workspace. VozCore analyses your intent, plans the work and
                    delegates to specialist agents — real model calls, real results.
                  </p>
                  {unconfigured ? (
                    <p className="mx-auto mt-2 max-w-md rounded-lg border border-gild-500/30 bg-gild-500/8 px-3 py-2 text-[11.5px] leading-relaxed text-gild-400">
                      {engine.kind === 'ready' ? engine.health.message : null}
                    </p>
                  ) : null}
                </div>
                <div className="flex w-full max-w-lg flex-col gap-2">
                  {SUGGESTIONS.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      onClick={() => setText(suggestion)}
                      className="focus-ring rounded-xl border border-white/10 bg-white/4 px-4 py-2.5 text-left text-xs text-mist-400 transition hover:border-white/18 hover:bg-white/7 hover:text-mist-200"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            ) : loadingThread ? (
              <div className="flex justify-center py-16">
                <Spinner size={22} />
              </div>
            ) : messages.length === 0 && !execution ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                <MessageSquare size={22} className="text-mist-500" />
                <p className="text-sm text-mist-400">No messages yet — send the first command below.</p>
              </div>
            ) : (
              <div className="mx-auto flex max-w-3xl flex-col gap-5">
                {messages.map((message) => (
                  <MessageBubble key={message.id} message={message} />
                ))}

                {/* Engine configuration / connectivity error — never a fake reply */}
                {commandError ? (
                  <div className="flex items-start gap-3 rounded-2xl border border-rosh-500/35 bg-rosh-500/8 px-4 py-3.5">
                    <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-rosh-500/15 text-rosh-400">
                      <AlertTriangle size={14} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-semibold text-rosh-400">Command not dispatched</p>
                      <p className="mt-1 break-words text-xs leading-relaxed text-mist-400">{commandError.message}</p>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<RefreshCw size={13} />}
                      loading={sending}
                      onClick={() => void retryCommand()}
                    >
                      Retry
                    </Button>
                  </div>
                ) : null}

                {/* Live / historical execution for this conversation */}
                {execution ? (
                  <ExecutionPanel
                    detail={execution}
                    onCancel={(id) => void cancelExecution(id)}
                    cancelling={cancelling}
                  />
                ) : null}
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Engine status strip */}
          <div className="border-t border-white/7 px-4 py-2 sm:px-6">
            <div className="flex flex-wrap items-center gap-2 text-[10.5px] text-mist-500">
              <span className={cn('inline-flex items-center gap-1.5 rounded-full border border-white/10 px-2 py-0.5', badge.text)}>
                <span className={cn('h-1.5 w-1.5 rounded-full', badge.dot)} /> {badge.label}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 px-2 py-0.5">
                <span className="h-1.5 w-1.5 rounded-full bg-verdant-500" /> Messages persist to PostgreSQL
              </span>
              <span className="hidden items-center gap-1.5 rounded-full border border-white/10 px-2 py-0.5 sm:inline-flex">
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
                {engine.kind === 'ready'
                  ? `${engine.health.graph.nodes.length}-node LangGraph pipeline`
                  : 'LangGraph orchestration'}
              </span>
              <span className="hidden items-center gap-1.5 rounded-full border border-white/10 px-2 py-0.5 md:inline-flex">
                <span className="h-1.5 w-1.5 rounded-full bg-gild-500" /> Task attachments enabled
              </span>
            </div>
          </div>

          {/* Composer */}
          <form onSubmit={send} className="border-t border-white/7 bg-void-900/50 px-4 py-4 sm:px-6">
            {attachments.length > 0 ? (
              <div className="mb-2.5 flex flex-wrap gap-2">
                {attachments.map((task) => (
                  <span
                    key={task.id}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-white/12 bg-white/5 py-1 pl-2.5 pr-1.5 text-[11px] text-mist-300"
                  >
                    <Check size={11} className="text-verdant-400" />
                    <span className="max-w-48 truncate">{task.title}</span>
                    <button
                      type="button"
                      onClick={() => setAttachments((current) => current.filter((item) => item.id !== task.id))}
                      aria-label={`Remove ${task.title}`}
                      className="focus-ring rounded p-0.5 text-mist-500 hover:text-rosh-400"
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            ) : null}

            <div className="flex items-end gap-2.5">
              <button
                type="button"
                onClick={() => void openPicker()}
                aria-label="Attach tasks"
                className="focus-ring flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/4 text-mist-400 transition hover:bg-white/8 hover:text-mist-200"
              >
                <Paperclip size={16} />
              </button>
              <textarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void send(event as unknown as FormEvent);
                  }
                }}
                rows={1}
                placeholder="Send a command to VozCore…"
                aria-label="Message"
                className="focus-ring max-h-40 min-h-10 flex-1 resize-none rounded-xl border border-white/10 bg-void-900 px-3.5 py-2.5 text-sm leading-relaxed text-mist-100 placeholder:text-mist-600 focus:border-[var(--accent)]"
                style={{ height: Math.min(160, Math.max(40, text.split('\n').length * 22 + 18)) }}
              />
              <Button
                type="submit"
                variant="primary"
                size="md"
                loading={sending}
                disabled={!text.trim()}
                aria-label="Send message"
                icon={<Send size={15} />}
                className="h-10 w-10 px-0"
              />
            </div>
            <p className="mt-2 text-[10.5px] text-mist-600">
              Enter to send · Shift+Enter for a new line · VozCore plans and dispatches every command
            </p>
          </form>
        </section>
      </div>

      {/* Task attachment picker */}
      <Modal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title="Attach tasks"
        description="Link existing open tasks to this message for context."
        footer={
          <>
            <Button variant="ghost" onClick={() => setPickerOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={confirmPicker}>
              Attach {picked.size > 0 ? `(${picked.size})` : ''}
            </Button>
          </>
        }
      >
        {attachable.length === 0 ? (
          <EmptyState
            compact
            title="No open tasks"
            description="Create tasks in the Task Manager to attach them here."
          />
        ) : (
          <ul className="flex flex-col gap-1.5">
            {attachable.map((task) => (
              <li key={task.id}>
                <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-white/8 px-3.5 py-2.5 transition hover:border-white/16 hover:bg-white/4">
                  <input
                    type="checkbox"
                    checked={picked.has(task.id)}
                    onChange={(event) => {
                      setPicked((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(task.id);
                        else next.delete(task.id);
                        return next;
                      });
                    }}
                    className="h-4 w-4 accent-[var(--accent)]"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm text-mist-200">{task.title}</span>
                  <StatusPill {...TASK_STATUS_META[task.status]} />
                </label>
              </li>
            ))}
          </ul>
        )}
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
        busy={deleteBusy}
        title="Delete conversation?"
        body={`“${deleteTarget?.title ?? ''}” and all of its messages will be permanently removed.`}
        confirmLabel="Delete conversation"
      />
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const isAssistant = message.role === 'assistant';
  if (isAssistant) {
    return (
      <div className="flex flex-col items-start gap-1.5">
        <div className="max-w-[85%] rounded-2xl rounded-bl-md border border-white/10 bg-white/5 px-4 py-2.5">
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-mist-100">{message.content}</p>
        </div>
        <span className="flex items-center gap-1.5 px-1 text-[10.5px] text-mist-600" title={formatDateTime(message.createdAt)}>
          <Sparkles size={10} className="text-[var(--accent)]" />
          VozCore · {formatRelative(message.createdAt)}
          {message.executionId ? <ExecutionStatusDotPlaceholder /> : null}
        </span>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="max-w-[85%] rounded-2xl rounded-br-md border border-[var(--accent)]/30 bg-[var(--accent-soft)] px-4 py-2.5">
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-mist-100">{message.content}</p>
        {message.attachments.length > 0 ? (
          <div className="mt-2.5 flex flex-wrap gap-1.5 border-t border-white/10 pt-2.5">
            {message.attachments.map((attachment) => (
              <span
                key={attachment.taskId}
                className="inline-flex items-center gap-1.5 rounded-md bg-black/25 px-2 py-1 text-[10.5px] text-mist-300"
              >
                <MessageSquare size={10} className="text-[var(--accent)]" />
                <span className="max-w-44 truncate">{attachment.title}</span>
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <span className="px-1 text-[10.5px] text-mist-600" title={formatDateTime(message.createdAt)}>
        {formatRelative(message.createdAt)}
      </span>
    </div>
  );
}

/** Tiny marker linking an assistant reply to its execution. */
function ExecutionStatusDotPlaceholder() {
  return (
    <span className="inline-flex items-center gap-1 text-verdant-500/90" title="Produced by a VozCore execution">
      <Activity size={9} />
      run
    </span>
  );
}
