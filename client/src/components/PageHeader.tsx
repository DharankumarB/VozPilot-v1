import type { ReactNode } from 'react';
import { cn } from '../lib/utils';

export function PageHeader({
  title,
  subtitle,
  actions,
  className,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-4', className)}>
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-mist-100 sm:text-2xl">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-mist-400">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
