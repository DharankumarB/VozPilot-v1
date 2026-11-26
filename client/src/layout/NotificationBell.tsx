import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, CalendarClock, ShieldCheck, TriangleAlert } from 'lucide-react';
import { api } from '../lib/api';
import type { NotificationPayload } from '../lib/types';
import { formatRelative, cn } from '../lib/utils';

const ICONS = {
  approval_pending: ShieldCheck,
  task_overdue: TriangleAlert,
  task_due_today: CalendarClock,
};

/**
 * Notification bell — real workspace signals only (pending approvals and
 * tasks that are due today or overdue). Polls gently and on focus.
 */
export function NotificationBell() {
  const navigate = useNavigate();
  const [payload, setPayload] = useState<NotificationPayload | null>(null);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    api
      .get<NotificationPayload>('/api/activity/notifications')
      .then(setPayload)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    load();
    const interval = window.setInterval(load, 60_000);
    window.addEventListener('focus', load);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', load);
    };
  }, [load]);

  useEffect(() => {
    const onPointer = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, []);

  const count = payload?.unreadCount ?? 0;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={`Notifications${count > 0 ? ` (${count} unread)` : ''}`}
        className="focus-ring relative flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/4 text-mist-400 transition hover:bg-white/8 hover:text-mist-200"
      >
        <Bell size={16} />
        {count > 0 ? (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-gild-500 px-1 text-[9.5px] font-bold text-void-950">
            {count > 9 ? '9+' : count}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="glass anim-scale-in absolute right-0 top-11 z-50 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-xl shadow-2xl shadow-black/50">
          <div className="flex items-center justify-between border-b border-white/8 px-4 py-3">
            <p className="text-sm font-semibold text-mist-100">Notifications</p>
            <span className="text-[11px] text-mist-500">{count} open</span>
          </div>
          {!payload || payload.items.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs leading-relaxed text-mist-500">
              Nothing needs your attention right now.
            </p>
          ) : (
            <ul className="max-h-80 overflow-y-auto p-2">
              {payload.items.map((item) => {
                const Icon = ICONS[item.type] ?? ShieldCheck;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setOpen(false);
                        navigate(item.link);
                      }}
                      className="focus-ring flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition hover:bg-white/6"
                    >
                      <span
                        className={cn(
                          'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border',
                          item.type === 'task_overdue'
                            ? 'border-rosh-500/30 bg-rosh-500/10 text-rosh-400'
                            : item.type === 'approval_pending'
                              ? 'border-gild-500/30 bg-gild-500/10 text-gild-400'
                              : 'border-azure-500/30 bg-azure-500/10 text-azure-400',
                        )}
                      >
                        <Icon size={13} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium text-mist-200">{item.title}</span>
                        <span className="mt-0.5 block text-[11px] text-mist-500">
                          {item.detail} · {formatRelative(item.createdAt)}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
