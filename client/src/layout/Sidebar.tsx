import { NavLink } from 'react-router-dom';
import { ChevronLeft, Rocket } from 'lucide-react';
import { NAV_ITEMS } from '../lib/constants';
import { Wordmark } from '../components/brand/Logo';
import { cn } from '../lib/utils';

interface SidebarProps {
  collapsed: boolean;
  mobileOpen: boolean;
  onToggle: () => void;
  onCloseMobile: () => void;
}

export function Sidebar({ collapsed, mobileOpen, onToggle, onCloseMobile }: SidebarProps) {
  return (
    <>
      {/* Mobile scrim */}
      <div
        className={cn(
          'fixed inset-0 z-40 bg-black/60 backdrop-blur-sm transition-opacity lg:hidden',
          mobileOpen ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        onClick={onCloseMobile}
        aria-hidden="true"
      />

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex flex-col border-r border-white/7 bg-void-900/95 backdrop-blur-xl transition-[width,transform] duration-200 ease-out',
          collapsed ? 'w-[72px]' : 'w-[260px]',
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
        )}
        aria-label="Primary navigation"
      >
        {/* Brand */}
        <div className={cn('flex h-16 shrink-0 items-center border-b border-white/7', collapsed ? 'justify-center px-2' : 'px-4')}>
          <NavLink to="/" onClick={onCloseMobile} className="focus-ring rounded-lg" aria-label="VozPilot overview">
            <Wordmark compact={collapsed} />
          </NavLink>
        </div>

        {/* Nav */}
        <nav className={cn('flex-1 overflow-y-auto py-4', collapsed ? 'px-2.5' : 'px-3')}>
          <ul className="flex flex-col gap-1">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              return (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.end}
                    onClick={onCloseMobile}
                    title={collapsed ? item.label : undefined}
                    className={({ isActive }) =>
                      cn(
                        'focus-ring group relative flex items-center gap-3 rounded-xl text-sm transition-colors',
                        collapsed ? 'h-10 justify-center px-0' : 'h-10 px-3',
                        isActive
                          ? 'bg-[var(--accent-soft)] text-mist-100'
                          : 'text-mist-400 hover:bg-white/5 hover:text-mist-200',
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <span
                          className={cn(
                            'absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-[var(--accent)] transition-opacity',
                            isActive ? 'opacity-100' : 'opacity-0',
                          )}
                          aria-hidden="true"
                        />
                        <Icon
                          size={17}
                          className={cn(
                            'shrink-0 transition-colors',
                            isActive ? 'text-[var(--accent)]' : 'text-mist-500 group-hover:text-mist-300',
                          )}
                        />
                        {!collapsed ? (
                          <span className="truncate font-medium">{item.label}</span>
                        ) : null}
                      </>
                    )}
                  </NavLink>
                </li>
              );
            })}
          </ul>

          {!collapsed ? (
            <div className="glass mt-6 rounded-xl p-3.5">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-gild-400">
                <Rocket size={12} />
                Phase 1
              </div>
              <p className="mt-1.5 text-[11px] leading-relaxed text-mist-500">
                Workforce foundation is live. VozCore orchestration connects in Phase 2.
              </p>
            </div>
          ) : null}
        </nav>

        {/* Footer */}
        <div className={cn('shrink-0 border-t border-white/7 py-3', collapsed ? 'px-2' : 'px-4')}>
          <div className={cn('flex items-center', collapsed ? 'justify-center' : 'justify-between gap-2')}>
            {!collapsed ? (
              <div className="min-w-0">
                <p className="truncate text-[11px] font-medium text-mist-400">VozLook Studios</p>
                <p className="text-[10px] text-mist-600">VozPilot v1 · Phase 1</p>
              </div>
            ) : null}
            <button
              type="button"
              onClick={onToggle}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              className="focus-ring hidden h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/4 text-mist-400 transition hover:bg-white/8 hover:text-mist-200 lg:flex"
            >
              <ChevronLeft size={15} className={cn('transition-transform duration-200', collapsed && 'rotate-180')} />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
