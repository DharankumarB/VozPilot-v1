import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api, setUnauthenticatedHandler, type ApiError } from '../lib/api';
import type { User, UserPreferences } from '../lib/types';

type AuthStatus = 'loading' | 'authenticated' | 'guest';

interface AuthContextValue {
  status: AuthStatus;
  user: User | null;
  preferences: UserPreferences;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Replace cached user after profile/settings updates. */
  setUser: (user: User) => void;
  /** Re-fetch /auth/me (e.g. after preferences change). */
  reloadUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const ACCENTS: Record<
  NonNullable<NonNullable<UserPreferences['appearance']>['accent']>,
  { base: string; strong: string }
> = {
  violet: { base: '#7c5cff', strong: '#6544e8' },
  gold: { base: '#d9a94e', strong: '#b98a36' },
  teal: { base: '#2dd4bf', strong: '#14b8a6' },
  rose: { base: '#fb7185', strong: '#f43f5e' },
};

/** Push persisted appearance preferences onto the document. */
function applyAppearance(preferences: UserPreferences): void {
  const accent = preferences.appearance?.accent ?? 'violet';
  const palette = ACCENTS[accent] ?? ACCENTS.violet;
  const root = document.documentElement;
  root.style.setProperty('--accent', palette.base);
  root.style.setProperty('--accent-strong', palette.strong);
  root.dataset.density = preferences.appearance?.density ?? 'comfortable';
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUserState] = useState<User | null>(null);
  const bootstrapRef = useRef(false);

  const setUser = useCallback((next: User) => {
    setUserState(next);
    applyAppearance(next.preferences ?? {});
  }, []);

  const clearSession = useCallback(() => {
    setUserState(null);
    setStatus('guest');
    applyAppearance({});
  }, []);

  const reloadUser = useCallback(async () => {
    try {
      const data = await api.get<{ user: User }>('/api/auth/me');
      setUser(data.user);
      setStatus('authenticated');
    } catch {
      clearSession();
    }
  }, [setUser, clearSession]);

  // Bootstrap session: try current access cookie, then the refresh cookie.
  useEffect(() => {
    if (bootstrapRef.current) return;
    bootstrapRef.current = true;
    void (async () => {
      try {
        const data = await api.get<{ user: User }>('/api/auth/me');
        setUser(data.user);
        setStatus('authenticated');
      } catch {
        const refreshed = await fetch('/api/auth/refresh', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
        }).catch(() => null);
        if (refreshed?.ok) {
          try {
            const payload = await refreshed.json();
            setUser(payload.data.user);
            setStatus('authenticated');
            return;
          } catch {
            /* fall through */
          }
        }
        clearSession();
      }
    })();
  }, [setUser, clearSession]);

  // A request that ends in 401 (after failed refresh) ends the session.
  useEffect(() => {
    setUnauthenticatedHandler(clearSession);
  }, [clearSession]);

  const login = useCallback(
    async (email: string, password: string) => {
      const data = await api.post<{ user: User }>('/api/auth/login', { email, password });
      setUser(data.user);
      setStatus('authenticated');
    },
    [setUser],
  );

  const register = useCallback(
    async (name: string, email: string, password: string) => {
      const data = await api.post<{ user: User }>('/api/auth/register', { name, email, password });
      setUser(data.user);
      setStatus('authenticated');
    },
    [setUser],
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/api/auth/logout');
    } finally {
      clearSession();
    }
  }, [clearSession]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      preferences: user?.preferences ?? {},
      login,
      register,
      logout,
      setUser,
      reloadUser,
    }),
    [status, user, login, register, logout, setUser, reloadUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}

export function isApiError(error: unknown): error is ApiError {
  return Boolean(error && typeof error === 'object' && 'status' in error && 'code' in error);
}

export function errorMessage(error: unknown): string {
  if (isApiError(error)) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong. Please try again.';
}
