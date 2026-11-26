import { Navigate, Outlet, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from '../context/AuthContext';
import { LogoMark } from './brand/Logo';
import { Spinner } from './ui/Feedback';

/** Full-screen brand splash while the session bootstraps. */
export function BootSplash() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4">
      <LogoMark size={44} className="anim-fade" />
      <div className="flex items-center gap-2.5 text-xs text-mist-500">
        <Spinner size={15} />
        Restoring your workspace…
      </div>
    </div>
  );
}

/** Requires a session; otherwise redirects to /login. */
export function RequireAuth({ children }: { children?: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <BootSplash />;
  if (status === 'guest') {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return children ? <>{children}</> : <Outlet />;
}

/** Keeps signed-in users out of the login/register pages. */
export function PublicOnly({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  if (status === 'loading') return <BootSplash />;
  if (status === 'authenticated') return <Navigate to="/" replace />;
  return <>{children}</>;
}
