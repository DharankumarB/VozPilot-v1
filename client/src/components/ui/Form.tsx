import { forwardRef, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

/* --------------------------------- Field --------------------------------- */

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
  className,
}: {
  label: string;
  hint?: string;
  error?: string;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-xs font-medium text-mist-300">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-rosh-400" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-mist-500">{hint}</p>
      ) : null}
    </div>
  );
}

/* --------------------------------- Input --------------------------------- */

const CONTROL =
  'focus-ring w-full rounded-xl border border-white/10 bg-void-900/80 px-3.5 text-sm text-mist-100 placeholder:text-mist-600 transition-colors hover:border-white/20 focus:border-[var(--accent)] disabled:opacity-50';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={cn(CONTROL, 'h-10', className)} {...rest} />;
  },
);

/* -------------------------------- Textarea -------------------------------- */

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return <textarea ref={ref} className={cn(CONTROL, 'min-h-24 resize-y py-2.5 leading-relaxed', className)} {...rest} />;
  },
);

/* --------------------------------- Select --------------------------------- */

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...rest }, ref) {
    return (
      <div className="relative">
        <select
          ref={ref}
          className={cn(CONTROL, 'h-10 cursor-pointer appearance-none pr-9', className)}
          {...rest}
        >
          {children}
        </select>
        <svg
          viewBox="0 0 12 12"
          aria-hidden="true"
          className="pointer-events-none absolute right-3 top-1/2 h-3 w-3 -translate-y-1/2 fill-none stroke-mist-500"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2.5 4.5 6 8l3.5-3.5" />
        </svg>
      </div>
    );
  },
);
