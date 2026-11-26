/** Typed fetch wrapper for the VozPilot API (same-origin, cookie auth). */

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

let refreshPromise: Promise<boolean> | null = null;
let onUnauthenticated: (() => void) | null = null;

/** Registered by AuthContext so a failed refresh can clear the session. */
export function setUnauthenticatedHandler(handler: () => void): void {
  onUnauthenticated = handler;
}

async function tryRefresh(): Promise<boolean> {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        const res = await fetch('/api/auth/refresh', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
        });
        return res.ok;
      } catch {
        return false;
      }
    })().finally(() => {
      // Allow future attempts after this round settles.
      setTimeout(() => {
        refreshPromise = null;
      }, 0);
    });
  }
  return refreshPromise;
}

async function request<T>(path: string, options: RequestOptions = {}, isRetry = false): Promise<T> {
  const { method = 'GET', body, signal } = options;

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'include',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, 'network_error', 'Could not reach the VozPilot API. Check your connection.');
  }

  if (res.status === 401 && !isRetry && !path.startsWith('/api/auth/login') && !path.startsWith('/api/auth/register')) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      return request<T>(path, options, true);
    }
    onUnauthenticated?.();
    const payload = await res.json().catch(() => null);
    throw new ApiError(401, payload?.error?.code ?? 'unauthenticated', payload?.error?.message ?? 'Please sign in to continue.');
  }

  const payload = await res.json().catch(() => null);

  if (!res.ok) {
    const error = payload?.error;
    throw new ApiError(
      res.status,
      error?.code ?? 'request_failed',
      error?.message ?? `Request failed with status ${res.status}.`,
      error?.details,
    );
  }

  return (payload?.data ?? null) as T;
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) => request<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'POST', body }),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'PATCH', body }),
  delete: <T>(path: string, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'DELETE' }),
};

/** Build a query string from a params object, skipping empty values. */
export function qs(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '' || value === 'all') continue;
    search.set(key, String(value));
  }
  const str = search.toString();
  return str ? `?${str}` : '';
}
