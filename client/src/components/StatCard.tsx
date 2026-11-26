import type { ComponentType, ReactNode } from 'react';
import type { LucideProps } from 'lucide-react';
import { TrendingUp } from 'lucide-react';
import { cn } from '../lib/utils';

export function StatCard({
  label,
  value,
  caption,
  icon: Icon,
  tone = 'neutral',
  delta,
  className,
}: {
  label: string;
  value: ReactNode;
  caption?: string;
  icon: ComponentType<LucideProps>;
  tone?: 'neutral' | 'violet' | 'gold' | 'success' | 'warning' | 'danger';
  delta?: string;
  className?: string;
}) {
  const iconTones: Record<string, string> = {
    neutral: 'text-mist-400 bg-white/5 border-white/10',
    violet: 'text-[var(--accent)] bg-[var(--accent-faint)] border-[var(--accent)]/25',
    gold: 'text-gild-400 bg-gild-500/10 border-gild-500/25',
    success: 'text-verdant-400 bg-verdant-500/10 border-verdant-500/25',
    warning: 'text-lume-400 bg-lume-500/10 border-lume-500/25',
    danger: 'text-rosh-400 bg-rosh-500/10 border-rosh-500/25',
  };

  return (
    <div className={cn('glass glass-hover rounded-2xl p-4 sm:p-5', className)}>
      <div className="flex items-start justify-between gap-3">
        <p className="micro-label">{label}</p>
        <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border', iconTones[tone])}>
          <Icon size={15} />
        </span>
      </div>
      <div className="mt-3 flex items-baseline gap-2">
        <span className="text-2xl font-semibold tracking-tight text-mist-100 sm:text-[1.7rem]">{value}</span>
        {delta ? (
          <span className="inline-flex items-center gap-0.5 text-xs font-medium text-verdant-400">
            <TrendingUp size={12} />
            {delta}
          </span>
        ) : null}
      </div>
      {caption ? <p className="mt-1.5 text-xs leading-relaxed text-mist-500">{caption}</p> : null}
    </div>
  );
}
