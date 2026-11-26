import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Brain, Pencil, Plus, Search, Tags, Trash2 } from 'lucide-react';
import { api, qs } from '../lib/api';
import type { Memory } from '../lib/types';
import { useToast } from '../context/ToastContext';
import { errorMessage } from '../context/AuthContext';
import { Button } from '../components/ui/Button';
import { Field, Input, Textarea } from '../components/ui/Form';
import { Modal, ConfirmDialog } from '../components/ui/Modal';
import { PageHeader } from '../components/PageHeader';
import { Chip } from '../components/ui/Badge';
import { EmptyState, ListSkeleton } from '../components/ui/Feedback';
import { cn, formatRelative } from '../lib/utils';
import { useDebouncedValue } from '../hooks/useDebounce';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

interface MemoryForm {
  title: string;
  category: string;
  content: string;
  tags: string;
}

const EMPTY_FORM: MemoryForm = { title: '', category: 'general', content: '', tags: '' };

export function MemoryCenterPage() {
  useDocumentTitle('Memory Center · VozPilot');
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [search, setSearch] = useState(searchParams.get('q') ?? '');
  const debounced = useDebouncedValue(search, 300);
  const [category, setCategory] = useState(searchParams.get('category') ?? 'all');

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Memory | null>(null);
  const [form, setForm] = useState<MemoryForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Memory | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const data = await api.get<{ memories: Memory[]; categories: string[] }>(
        `/api/memories${qs({ q: debounced.trim() || undefined, category })}`,
      );
      setMemories(data.memories);
      setCategories(data.categories);
    } catch (caught) {
      setLoadError(errorMessage(caught));
    }
  }, [debounced, category]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setSearchParams(
      new URLSearchParams(
        qs({ q: debounced.trim() || undefined, category: category === 'all' ? undefined : category }),
      ),
      { replace: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced, category]);

  const openCreate = () => {
    setEditing(null);
    setForm({ ...EMPTY_FORM, category: category !== 'all' ? category : 'general' });
    setFormError(null);
    setFormOpen(true);
  };

  const openEdit = (memory: Memory) => {
    setEditing(memory);
    setForm({
      title: memory.title,
      category: memory.category,
      content: memory.content,
      tags: memory.tags.join(', '),
    });
    setFormError(null);
    setFormOpen(true);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.title.trim()) {
      setFormError('Title is required.');
      return;
    }
    setSaving(true);
    setFormError(null);
    const payload = {
      title: form.title.trim(),
      category: form.category.trim() || 'general',
      content: form.content,
      tags: form.tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
    };
    try {
      if (editing) {
        await api.patch<Memory>(`/api/memories/${editing.id}`, payload);
        toast.success('Memory updated', payload.title);
      } else {
        await api.post<Memory>('/api/memories', payload);
        toast.success('Memory stored', payload.title);
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
      await api.delete(`/api/memories/${deleteTarget.id}`);
      toast.success('Memory deleted', deleteTarget.title);
      setDeleteTarget(null);
      await load();
    } catch (caught) {
      toast.error('Could not delete memory', errorMessage(caught));
    } finally {
      setDeleteBusy(false);
    }
  };

  const hasFilters = search.trim() !== '' || category !== 'all';

  return (
    <div className="anim-enter flex flex-col gap-5">
      <PageHeader
        title="Memory Center"
        subtitle="Searchable long-term knowledge — project context, decisions and reference material."
        actions={
          <Button variant="primary" icon={<Plus size={15} />} onClick={openCreate}>
            New memory
          </Button>
        }
      />

      <div className="glass flex flex-wrap items-center gap-3 rounded-2xl p-3">
        <div className="relative min-w-56 flex-1">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-mist-500" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search titles, content or tags…"
            aria-label="Search memories"
            className="focus-ring h-9 w-full rounded-xl border border-white/10 bg-void-900/70 pl-9 pr-3 text-sm text-mist-100 placeholder:text-mist-500 focus:border-[var(--accent)]"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Chip active={category === 'all'} onClick={() => setCategory('all')}>
            All
          </Chip>
          {categories.map((item) => (
            <Chip key={item} active={category === item} onClick={() => setCategory(item)}>
              {item}
            </Chip>
          ))}
        </div>
      </div>

      {loadError && !memories ? (
        <EmptyState title="Couldn't load memories" description={loadError} action={<Button onClick={() => void load()}>Retry</Button>} />
      ) : !memories ? (
        <ListSkeleton rows={4} />
      ) : memories.length === 0 ? (
        <EmptyState
          icon={<Brain size={20} />}
          title={hasFilters ? 'No memories match' : 'No memories stored yet'}
          description={
            hasFilters
              ? 'Try a different search term or category.'
              : 'Store project briefs, decisions and reference notes so every agent can recall context.'
          }
          action={
            hasFilters ? (
              <Button
                onClick={() => {
                  setSearch('');
                  setCategory('all');
                }}
              >
                Clear filters
              </Button>
            ) : (
              <Button variant="primary" icon={<Plus size={15} />} onClick={openCreate}>
                Store first memory
              </Button>
            )
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {memories.map((memory) => (
            <article key={memory.id} className="glass glass-hover group flex flex-col rounded-2xl p-5">
              <div className="flex items-start justify-between gap-3">
                <span className="micro-label !text-gild-500">{memory.category}</span>
                <div className="flex gap-1 opacity-60 transition group-hover:opacity-100">
                  <button
                    type="button"
                    onClick={() => openEdit(memory)}
                    aria-label={`Edit ${memory.title}`}
                    className="focus-ring rounded-lg p-1.5 text-mist-400 transition hover:bg-white/8 hover:text-mist-100"
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeleteTarget(memory)}
                    aria-label={`Delete ${memory.title}`}
                    className="focus-ring rounded-lg p-1.5 text-mist-400 transition hover:bg-rosh-500/12 hover:text-rosh-400"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
              <h2 className="mt-2 text-[15px] font-semibold text-mist-100">{memory.title}</h2>
              <p className="mt-1.5 line-clamp-4 flex-1 whitespace-pre-wrap text-xs leading-relaxed text-mist-400">
                {memory.content || <span className="italic text-mist-600">No content.</span>}
              </p>
              {memory.tags.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {memory.tags.map((tag) => (
                    <span
                      key={tag}
                      className="inline-flex items-center gap-1 rounded-md bg-white/5 px-2 py-0.5 text-[10.5px] text-mist-400"
                    >
                      <Tags size={9} />
                      {tag}
                    </span>
                  ))}
                </div>
              ) : null}
              <p className="mt-3 border-t border-white/7 pt-3 text-[11px] text-mist-600">
                Updated {formatRelative(memory.updatedAt)}
              </p>
            </article>
          ))}
        </div>
      )}

      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={editing ? 'Edit memory' : 'New memory'}
        description="Everything here is searchable from the Memory Center and global search."
        busy={saving}
        footer={
          <>
            <Button variant="ghost" onClick={() => setFormOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" form="memory-form" loading={saving}>
              {editing ? 'Save changes' : 'Store memory'}
            </Button>
          </>
        }
      >
        <form id="memory-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
          {formError ? (
            <div className="rounded-xl border border-rosh-500/30 bg-rosh-500/10 px-3.5 py-2.5 text-xs text-rosh-400" role="alert">
              {formError}
            </div>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Title" htmlFor="mem-title">
              <Input
                id="mem-title"
                value={form.title}
                onChange={(event) => setForm((f) => ({ ...f, title: event.target.value }))}
                placeholder="e.g. Pricing decision — Nov 2026"
                maxLength={200}
                autoFocus
                required
              />
            </Field>
            <Field label="Category" htmlFor="mem-category" hint="Letters, numbers, spaces, dashes.">
              <Input
                id="mem-category"
                value={form.category}
                onChange={(event) => setForm((f) => ({ ...f, category: event.target.value }))}
                placeholder="general"
                maxLength={60}
                list="memory-categories"
              />
              <datalist id="memory-categories">
                {categories.map((item) => (
                  <option key={item} value={item} />
                ))}
              </datalist>
            </Field>
          </div>

          <Field label="Content" htmlFor="mem-content">
            <Textarea
              id="mem-content"
              value={form.content}
              onChange={(event) => setForm((f) => ({ ...f, content: event.target.value }))}
              rows={7}
              maxLength={20000}
              placeholder="Project context, decisions, links, constraints…"
            />
          </Field>

          <Field label="Tags" htmlFor="mem-tags" hint="Comma separated — e.g. launch, pricing, decision">
            <Input
              id="mem-tags"
              value={form.tags}
              onChange={(event) => setForm((f) => ({ ...f, tags: event.target.value }))}
              placeholder="launch, pricing"
            />
          </Field>
        </form>
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
        busy={deleteBusy}
        title="Delete memory?"
        body={`“${deleteTarget?.title ?? ''}” will be permanently removed from long-term memory. This cannot be undone.`}
        confirmLabel="Delete memory"
      />
    </div>
  );
}
