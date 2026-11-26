import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

/* --------------------------------- Badge --------------------------------- */

export function Badge({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium tracking-wide',
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Dot + label pill driven by a status meta record. */
export function StatusPill({
  label,
  text,
  bg,
  dot,
  pulse = false,
  className,
}: {
  label: string;
  text: string;
  bg: string;
  dot: string;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <Badge className={cn(text, bg, className)}>
      <span className={cn('h-1.5 w-1.5 rounded-full', dot, pulse && 'pulse-dot')} aria-hidden="true" />
      {label}
    </Badge>
  );
}

/** Compact outline pill (categories, counts, dates). */
export function Chip({
  children,
  active = false,
  onClick,
  className,
  title,
}: {
  children: ReactNode;
  active?: boolean;
  onClick?: () => void;
  className?: string;
  title?: string;
}) {
  const base =
    'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors';
  const tone = active
    ? 'border-[var(--accent)]/50 bg-[var(--accent-soft)] text-[var(--accent)]'
    : 'border-white/10 bg-white/4 text-mist-400 hover:border-white/20 hover:text-mist-200';
  if (onClick) {
    return (
      <button type="button" onClick={onClick} title={title} className={cn(base, tone, 'focus-ring', className)}>
        {children}
      </button>
    );
  }
  return (
    <span title={title} className={cn(base, tone, className)}>
      {children}
    </span>
  );
}
