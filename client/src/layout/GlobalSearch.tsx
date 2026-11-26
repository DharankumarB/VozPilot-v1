import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bot, ListTodo, Brain, Search, CornerDownLeft } from 'lucide-react';
import { api, qs } from '../lib/api';
import type { SearchResults } from '../lib/types';
import { useDebouncedValue } from '../hooks/useDebounce';
import { cn, formatDueDate } from '../lib/utils';
import { TASK_STATUS_META } from '../lib/constants';
import { agentIcon } from '../lib/constants';

/**
 * Global search — tasks, agents and memories with grouped dropdown results.
 */
export function GlobalSearch() {
  const navigate = useNavigate();
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const debounced = useDebouncedValue(term, 280);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Fetch results for the debounced term.
  useEffect(() => {
    if (!debounced.trim()) {
      setResults(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    api
      .get<SearchResults>(`/api/search${qs({ q: debounced.trim(), limit: 5 })}`, { signal: controller.signal })
      .then((data) => {
        setResults(data);
        setOpen(true);
      })
      .catch(() => {
        /* closed or failed — dropdown simply stays empty */
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [debounced]);

  // Close on outside click / Escape.
  useEffect(() => {
    const onPointer = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
      if (event.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  const go = useCallback(
    (path: string) => {
      setOpen(false);
      setTerm('');
      navigate(path);
    },
    [navigate],
  );

  const total = results ? results.tasks.length + results.agents.length + results.memories.length : 0;
  const showDropdown = open && term.trim().length > 0;

  return (
    <div ref={containerRef} className="relative w-full max-w-md">
      <div className="relative">
        <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-mist-500" />
        <input
          ref={inputRef}
          type="search"
          value={term}
          onChange={(event) => {
            setTerm(event.target.value);
            setOpen(true);
          }}
          onFocus={() => term.trim() && setOpen(true)}
          placeholder="Search tasks, agents, memories…"
          aria-label="Global search"
          className="focus-ring h-9 w-full rounded-xl border border-white/10 bg-white/4 pl-9 pr-12 text-sm text-mist-100 placeholder:text-mist-500 transition-colors hover:border-white/15 focus:border-[var(--accent)] focus:bg-void-900"
        />
        <kbd className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 rounded border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-mist-500 sm:block">
          /
        </kbd>
      </div>

      {showDropdown ? (
        <div className="glass absolute left-0 right-0 top-11 z-50 max-h-96 overflow-y-auto rounded-xl p-2 shadow-2xl shadow-black/50">
          {loading && !results ? (
            <p className="px-3 py-4 text-xs text-mist-500">Searching…</p>
          ) : total === 0 ? (
            <p className="px-3 py-4 text-xs text-mist-500">No matches for “{term.trim()}”.</p>
          ) : (
            <>
              {results?.tasks.length ? (
                <SearchGroup label="Tasks">
                  {results.tasks.map((task) => (
                    <SearchRow
                      key={task.id}
                      icon={<ListTodo size={14} className="text-mist-400" />}
                      title={task.title}
                      meta={TASK_STATUS_META[task.status]?.label ?? task.status}
                      onClick={() => go(`/tasks${qs({ q: task.title })}`)}
                    />
                  ))}
                </SearchGroup>
              ) : null}
              {results?.agents.length ? (
                <SearchGroup label="Agents">
                  {results.agents.map((agent) => {
                    const Icon = agentIcon(agent.icon);
                    return (
                      <SearchRow
                        key={agent.id}
                        icon={<Icon size={14} className="text-[var(--accent)]" />}
                        title={agent.name}
                        meta={agent.status}
                        onClick={() => go(`/agents/${agent.id}`)}
                      />
                    );
                  })}
                </SearchGroup>
              ) : null}
              {results?.memories.length ? (
                <SearchGroup label="Memories">
                  {results.memories.map((memory) => (
                    <SearchRow
                      key={memory.id}
                      icon={<Brain size={14} className="text-gild-400" />}
                      title={memory.title}
                      meta={memory.category}
                      onClick={() => go(`/memories${qs({ q: memory.title })}`)}
                    />
                  ))}
                </SearchGroup>
              ) : null}
              <button
                type="button"
                onClick={() => go(`/tasks${qs({ q: term.trim() })}`)}
                className="mt-1 flex w-full items-center justify-between rounded-lg px-3 py-2 text-xs text-mist-400 transition hover:bg-white/5 hover:text-mist-200"
              >
                View all results in Task Manager
                <CornerDownLeft size={12} />
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function SearchGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-1.5 last:mb-0">
      <p className="micro-label px-3 pb-1 pt-2">{label}</p>
      {children}
    </div>
  );
}

function SearchRow({
  icon,
  title,
  meta,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  meta: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition hover:bg-white/6',
        'focus-ring',
      )}
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/4">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-mist-200">{title}</span>
      </span>
      <span className="shrink-0 text-[10px] uppercase tracking-wider text-mist-500">{meta}</span>
    </button>
  );
}
