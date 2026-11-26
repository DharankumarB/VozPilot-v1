/** Shared client-side utilities. */

export function cn(...values: (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(' ');
}

const DATE_FMT = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});
const DATE_TIME_FMT = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});
const TIME_FMT = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return DATE_FMT.format(date);
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return DATE_TIME_FMT.format(date);
}

export function formatTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return TIME_FMT.format(date);
}

/** "just now" / "4m ago" / "yesterday" / "Mar 3" style relative labels. */
export function formatRelative(value: string | null | undefined): string {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Never';

  const diffMs = Date.now() - date.getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return DATE_FMT.format(date);
}

/** Countdown label for due dates (YYYY-MM-DD). */
export function formatDueDate(dueDate: string | null | undefined): {
  label: string;
  tone: 'overdue' | 'today' | 'soon' | 'later' | 'none';
} {
  if (!dueDate) return { label: 'No due date', tone: 'none' };
  const due = new Date(`${dueDate.slice(0, 10)}T23:59:59`);
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  const tomorrow = new Date(today.getTime() + 86_400_000);
  const startOfTomorrow = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate());

  if (due.getTime() < Date.now()) return { label: formatDate(dueDate), tone: 'overdue' };
  if (due.getTime() <= today.getTime()) return { label: 'Today', tone: 'today' };
  if (due.getTime() < startOfTomorrow.getTime() + 86_400_000) return { label: 'Tomorrow', tone: 'soon' };
  return { label: formatDate(dueDate), tone: 'later' };
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function percent(value: number): string {
  return `${Math.round(value)}%`;
}
