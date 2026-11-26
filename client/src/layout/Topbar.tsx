import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronDown, LogOut, Menu, Palette, Settings, UserRound } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { Avatar, Wordmark } from '../components/brand/Logo';
import { GlobalSearch } from './GlobalSearch';
import { NotificationBell } from './NotificationBell';
import { useWorkspacePulse } from '../hooks/useWorkspacePulse';
import { cn } from '../lib/utils';

export function Topbar({ onOpenMobileNav }: { onOpenMobileNav: () => void }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { activeAgents, totalAgents } = useWorkspacePulse();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointer = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, []);

  const handleLogout = async () => {
    setMenuOpen(false);
    await logout();
    navigate('/login');
  };

  return (
    <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-3 border-b border-white/7 bg-void-950/85 px-4 backdrop-blur-xl sm:px-6">
      {/* Mobile menu + brand */}
      <button
        type="button"
        onClick={onOpenMobileNav}
        aria-label="Open navigation"
        className="focus-ring flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/4 text-mist-400 transition hover:text-mist-200 lg:hidden"
      >
        <Menu size={17} />
      </button>
      <Link to="/" className="focus-ring rounded-lg lg:hidden" aria-label="VozPilot overview">
        <Wordmark compact />
      </Link>

      {/* Desktop search */}
      <div className="hidden flex-1 justify-start lg:flex">
        <GlobalSearch />
      </div>
      <div className="flex-1 lg:hidden" />

      {/* Right side */}
      <div className="flex items-center gap-2.5">
        {/* Agent activity indicator */}
        <Link
          to="/agents"
          title={`${activeAgents} of ${totalAgents} agents active`}
          className="focus-ring hidden h-9 items-center gap-2 rounded-xl border border-white/10 bg-white/4 px-3 text-xs text-mist-300 transition hover:bg-white/8 sm:flex"
        >
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              activeAgents > 0 ? 'bg-verdant-500 pulse-dot' : 'bg-mist-500',
            )}
            aria-hidden="true"
          />
          <span className="font-medium">
            {activeAgents}
            <span className="text-mist-500">/{totalAgents}</span>
          </span>
          <span className="text-mist-500">active</span>
        </Link>

        <NotificationBell />

        {/* Profile menu */}
        <div ref={menuRef} className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((value) => !value)}
            aria-label="Open profile menu"
            aria-expanded={menuOpen}
            className="focus-ring flex items-center gap-2 rounded-xl border border-white/10 bg-white/4 py-1 pl-1 pr-2 transition hover:bg-white/8"
          >
            <Avatar name={user?.name ?? '?'} size={30} />
            <span className="hidden max-w-32 truncate text-xs font-medium text-mist-200 sm:block">
              {user?.name}
            </span>
            <ChevronDown size={13} className={cn('text-mist-500 transition-transform', menuOpen && 'rotate-180')} />
          </button>

          {menuOpen ? (
            <div className="glass anim-scale-in absolute right-0 top-12 z-50 w-60 overflow-hidden rounded-xl shadow-2xl shadow-black/50">
              <div className="border-b border-white/8 px-4 py-3">
                <p className="truncate text-sm font-medium text-mist-100">{user?.name}</p>
                <p className="mt-0.5 truncate text-xs text-mist-500">{user?.email}</p>
              </div>
              <div className="p-1.5">
                <MenuLink icon={<UserRound size={14} />} label="Profile settings" onClick={() => { setMenuOpen(false); navigate('/settings?tab=profile'); }} />
                <MenuLink icon={<Palette size={14} />} label="Appearance" onClick={() => { setMenuOpen(false); navigate('/settings?tab=appearance'); }} />
                <MenuLink icon={<Settings size={14} />} label="All settings" onClick={() => { setMenuOpen(false); navigate('/settings'); }} />
              </div>
              <div className="border-t border-white/8 p-1.5">
                <button
                  type="button"
                  onClick={() => void handleLogout()}
                  className="focus-ring flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-xs font-medium text-rosh-400 transition hover:bg-rosh-500/10"
                >
                  <LogOut size={14} />
                  Sign out
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}

function MenuLink({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="focus-ring flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-xs font-medium text-mist-300 transition hover:bg-white/6 hover:text-mist-100"
    >
      {icon}
      {label}
    </button>
  );
}
