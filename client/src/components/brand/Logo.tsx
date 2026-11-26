import { cn, initials } from '../../lib/utils';

/** VozPilot brand mark: violet flight-path V with a gold beacon. */
export function LogoMark({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      className={className}
      role="img"
      aria-label="VozPilot"
    >
      <rect width="40" height="40" rx="11" fill="#0e0e15" />
      <rect x="0.5" y="0.5" width="39" height="39" rx="10.5" stroke="rgba(255,255,255,0.10)" />
      <path
        d="M10 13.5 20 29l10-15.5"
        stroke="url(#vp-gradient)"
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M14.5 21.5h11" stroke="rgba(217,169,78,0.75)" strokeWidth="2" strokeLinecap="round" />
      <circle cx="20" cy="10.5" r="2.6" fill="#d9a94e" />
      <defs>
        <linearGradient id="vp-gradient" x1="10" y1="13" x2="30" y2="29" gradientUnits="userSpaceOnUse">
          <stop stopColor="#b7a4ff" />
          <stop offset="1" stopColor="#6544e8" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export function Wordmark({ compact = false, className }: { compact?: boolean; className?: string }) {
  return (
    <span className={cn('flex min-w-0 items-center gap-2.5', className)}>
      <LogoMark size={compact ? 28 : 32} />
      {!compact ? (
        <span className="flex min-w-0 flex-col leading-none">
          <span className="text-[15px] font-semibold tracking-tight text-mist-100">
            Voz<span className="text-[var(--accent)]">Pilot</span>
          </span>
          <span className="mt-0.5 text-[10px] font-medium uppercase tracking-[0.18em] text-mist-500">
            VozLook Studios
          </span>
        </span>
      ) : null}
    </span>
  );
}

export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full border border-[var(--accent)]/35 bg-[var(--accent-soft)] font-semibold text-[var(--accent)]"
      style={{ width: size, height: size, fontSize: size * 0.36 }}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}
