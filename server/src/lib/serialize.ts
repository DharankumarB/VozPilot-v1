/**
 * Shared row shapes and small mapping helpers used across services.
 */

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  role: string;
  preferences: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: string;
  preferences: Record<string, unknown>;
  createdAt: string;
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    preferences: row.preferences ?? {},
    createdAt: row.created_at.toISOString(),
  };
}

export function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function clampLimit(value: unknown, fallback = 50, max = 200): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}
