import { useCallback, useEffect, useState } from 'react';
import { Activity as ActivityIcon, RefreshCw } from 'lucide-react';
import { api, qs } from '../lib/api';
import type { ActivityItem } from '../lib/types';
import { useToast } from '../context/ToastContext';
import { errorMessage } from '../context/AuthContext';
import { PageHeader } from '../components/PageHeader';
import { Chip } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { EmptyState, ListSkeleton, Spinner } from '../components/ui/Feedback';
import { ACTIVITY_CATEGORY_META, ACTIVITY_FILTERS } from '../lib/constants';
import { formatDateTime, formatRelative } from '../lib/utils';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

const PAGE_SIZE = 30;

export function ActivityCenterPage() {
  useDocumentTitle('Activity Center · VozPilot');
  const toast = useToast();

  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [category, setCategory] = useState<string>('all');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(
    (offset = 0) => {
      if (offset === 0) setLoadError(null);
      return api
        .get<{ items: ActivityItem[]; total: number }>(`/api/activity${qs({ category, limit: PAGE_SIZE, offset })}`)
        .then((data) => {
          setTotal(data.total);
          setItems((current) => (offset === 0 ? data.items : [...(current ?? []), ...data.items]));
        })
        .catch((caught) => {
          if (offset === 0) setLoadError(errorMessage(caught));
          else toast.error('Could not load more', errorMessage(caught));
        });
    },
    [category, toast],
  );

  useEffect(() => {
    setItems(null);
    void load(0);
  }, [load]);

  const hasMore = items !== null && items.length < total;

  return (
    <div className="anim-enter flex flex-col gap-5">
      <PageHeader
        title="Activity Center"
        subtitle="A truthful record of real workspace events — every entry maps to something that actually happened."
        actions={
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCw size={13} />}
            onClick={() => {
              setItems(null);
              void load(0);
            }}
          >
            Refresh
          </Button>
        }
      />

      <div className="flex flex-wrap gap-2">
        {ACTIVITY_FILTERS.map((filter) => (
          <Chip key={filter} active={category === filter} onClick={() => setCategory(filter)}>
            {filter === 'all' ? 'All events' : ACTIVITY_CATEGORY_META[filter]?.label ?? filter}
          </Chip>
        ))}
      </div>

      {loadError && !items ? (
        <EmptyState title="Couldn't load activity" description={loadError} action={<Button onClick={() => void load(0)}>Retry</Button>} />
      ) : !items ? (
        <ListSkeleton rows={6} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<ActivityIcon size={20} />}
          title="No activity recorded yet"
          description={
            category === 'all'
              ? 'Events appear here as you create tasks, configure agents, resolve approvals and more.'
              : 'No events in this category yet.'
          }
          action={
            category !== 'all' ? (
              <Button onClick={() => setCategory('all')}>Show all events</Button>
            ) : undefined
          }
        />
      ) : (
        <>
          {/* Timeline */}
          <div className="glass rounded-2xl p-5 sm:p-6">
            <ul className="relative flex flex-col gap-1">
              <span className="absolute bottom-4 left-[17px] top-4 w-px bg-white/8" aria-hidden="true" />
              {items.map((item) => {
                const meta = ACTIVITY_CATEGORY_META[item.category] ?? ACTIVITY_CATEGORY_META.system;
                const Icon = meta.icon;
                return (
                  <li key={item.id} className="relative flex gap-4 py-2.5">
                    <span className="relative z-10 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-void-850 text-mist-400">
                      <Icon size={14} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
                        <p className="min-w-0 text-sm font-medium text-mist-200">{item.title}</p>
                        <time
                          className="shrink-0 text-[11px] text-mist-600"
                          dateTime={item.createdAt}
                          title={formatDateTime(item.createdAt)}
                        >
                          {formatRelative(item.createdAt)}
                        </time>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <span className="rounded-md bg-white/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-mist-500">
                          {meta.label}
                        </span>
                        {item.agentName ? (
                          <span className="text-[11px] text-mist-500">· {item.agentName}</span>
                        ) : null}
                        {item.detail ? (
                          <span className="truncate text-[11.5px] text-mist-500">{item.detail}</span>
                        ) : null}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>

            <div className="mt-4 flex items-center justify-between border-t border-white/7 pt-4 text-[11.5px] text-mist-500">
              <span>
                Showing {items.length} of {total} event{total === 1 ? '' : 's'}
              </span>
              {hasMore ? (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={loadingMore}
                  onClick={async () => {
                    setLoadingMore(true);
                    await load(items.length);
                    setLoadingMore(false);
                  }}
                >
                  Load more
                </Button>
              ) : (
                <span className="flex items-center gap-1.5 text-mist-600">
                  {items.length >= total ? (
                    <>
                      <span className="h-1.5 w-1.5 rounded-full bg-verdant-500" /> End of history
                    </>
                  ) : (
                    <Spinner size={12} />
                  )}
                </span>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
