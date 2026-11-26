import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { LoaderCircle } from 'lucide-react';
import { cn } from '../../lib/utils';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'gold';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-[var(--accent)] text-white hover:bg-[var(--accent-strong)] shadow-lg shadow-black/30 border border-transparent',
  secondary:
    'bg-white/6 text-mist-200 hover:bg-white/10 border border-white/10',
  ghost: 'bg-transparent text-mist-300 hover:bg-white/6 hover:text-mist-100 border border-transparent',
  danger: 'bg-rosh-600/90 text-white hover:bg-rosh-600 border border-transparent shadow-lg shadow-black/30',
  gold: 'bg-gild-500 text-void-950 hover:bg-gild-400 font-semibold border border-transparent shadow-lg shadow-black/30',
};

const SIZES: Record<Size, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5 rounded-lg',
  md: 'h-9.5 px-4 text-sm gap-2 rounded-xl',
  lg: 'h-11 px-5 text-sm gap-2 rounded-xl',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={cn(
        'focus-ring inline-flex select-none items-center justify-center whitespace-nowrap font-medium transition-all duration-150',
        'disabled:pointer-events-none disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? (
        <LoaderCircle size={size === 'sm' ? 14 : 16} className="animate-spin" />
      ) : (
        icon
      )}
      {children}
    </button>
  );
}
