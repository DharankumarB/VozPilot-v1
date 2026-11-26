import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';

const COLLAPSE_KEY = 'vozpilot.sidebar.collapsed';

export function AppShell() {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === '1');
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  const toggle = () => {
    setCollapsed((current) => {
      localStorage.setItem(COLLAPSE_KEY, current ? '0' : '1');
      return !current;
    });
  };

  return (
    <div className="min-h-dvh">
      <Sidebar
        collapsed={collapsed}
        mobileOpen={mobileOpen}
        onToggle={toggle}
        onCloseMobile={() => setMobileOpen(false)}
      />

      {/* Content offset matches the fixed sidebar (desktop only). */}
      <div
        className={`flex min-h-dvh flex-col transition-[padding] duration-200 ease-out ${
          collapsed ? 'lg:pl-[72px]' : 'lg:pl-[260px]'
        }`}
      >
        <Topbar onOpenMobileNav={() => setMobileOpen(true)} />
        <main className="mx-auto w-full max-w-[1500px] flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <Outlet />
        </main>
        <footer className="border-t border-white/6 px-6 py-4 text-center text-[11px] text-mist-600">
          VozPilot · Built by VozLook Studios · VozCore orchestration (Phase 2)
        </footer>
      </div>
    </div>
  );
}
