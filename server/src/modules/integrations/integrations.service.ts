import { z } from 'zod';
import { env } from '../../config/env';
import { withUser } from '../../db/pool';
import { logActivity } from '../../lib/activity';
import { BadRequestError, NotFoundError } from '../../lib/errors';
import { iso } from '../../lib/serialize';
import { DEFAULT_INTEGRATION_PROVIDERS } from '../../db/seedDefaults';

export type IntegrationProvider = (typeof DEFAULT_INTEGRATION_PROVIDERS)[number];
export type IntegrationStatus = 'not_connected' | 'connected' | 'error';

export interface IntegrationDto {
  provider: IntegrationProvider;
  status: IntegrationStatus;
  accountEmail: string | null;
  scopes: string[];
  lastError: string | null;
  connectedAt: string | null;
  updatedAt: string;
}

interface IntegrationRow {
  provider: IntegrationProvider;
  status: IntegrationStatus;
  account_email: string | null;
  scopes: string[] | null;
  last_error: string | null;
  connected_at: Date | null;
  updated_at: Date;
}

function mapIntegration(row: IntegrationRow): IntegrationDto {
  return {
    provider: row.provider,
    status: row.status,
    accountEmail: row.account_email,
    scopes: row.scopes ?? [],
    lastError: row.last_error,
    connectedAt: iso(row.connected_at),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function isProvider(value: string): value is IntegrationProvider {
  return (DEFAULT_INTEGRATION_PROVIDERS as readonly string[]).includes(value);
}

/**
 * OAuth credentials for a provider, read from the server environment only.
 * Returns null when the provider has not been configured yet.
 */
function oauthConfigured(provider: IntegrationProvider): { clientId: string; clientSecret: string } | null {
  switch (provider) {
    case 'gmail':
    case 'google_calendar':
    case 'google_drive':
      return env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
        : null;
    case 'github':
      return env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
        ? { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET }
        : null;
    case 'notion':
      return env.NOTION_CLIENT_ID && env.NOTION_CLIENT_SECRET
        ? { clientId: env.NOTION_CLIENT_ID, clientSecret: env.NOTION_CLIENT_SECRET }
        : null;
    default:
      return null;
  }
}

export async function listIntegrations(userId: string): Promise<IntegrationDto[]> {
  return withUser(userId, async (client) => {
    // Ensure rows exist for workspaces created before seeding logic existed.
    await client.query(
      `INSERT INTO integrations (user_id, provider, status)
       SELECT $1, provider, 'not_connected'
       FROM unnest($2::text[]) AS provider
       ON CONFLICT (user_id, provider) DO NOTHING`,
      [userId, [...DEFAULT_INTEGRATION_PROVIDERS]],
    );

    const result = await client.query<IntegrationRow>(
      `SELECT provider, status, account_email, scopes, last_error, connected_at, updated_at
       FROM integrations WHERE user_id = $1
       ORDER BY array_position($2::text[], provider)`,
      [userId, [...DEFAULT_INTEGRATION_PROVIDERS]],
    );
    return result.rows.map(mapIntegration);
  });
}

/**
 * Attempt to start a provider connection.
 *
 * Phase 1 honesty contract: this endpoint never reports a service as
 * connected. Without configured OAuth credentials (and before the Phase 2
 * callback flow exists) it fails with a clear, persisted error message so the
 * UI always reflects the truth.
 */
export async function connectIntegration(
  userId: string,
  provider: IntegrationProvider,
): Promise<IntegrationDto> {
  const config = oauthConfigured(provider);
  const failureReason = config
    ? 'OAuth credentials were found, but the authorization callback goes live in Phase 2. The connection stays "Not connected" until then.'
    : 'OAuth credentials for this provider are not configured on the server. Add them to the server environment (see .env.example), then try again.';

  await withUser(userId, async (client) => {
    await client.query(
      `INSERT INTO integrations (user_id, provider, status, last_error)
       VALUES ($1, $2, 'not_connected', $3)
       ON CONFLICT (user_id, provider)
       DO UPDATE SET status = CASE WHEN integrations.status = 'connected' THEN 'connected' ELSE 'not_connected' END,
                     last_error = $3,
                     updated_at = now()`,
      [userId, provider, failureReason],
    );
    await logActivity(client, {
      userId,
      type: 'integration_connect_attempted',
      category: 'integration',
      title: `Connection attempt: ${provider.replace('_', ' ')}`,
      detail: failureReason,
    });
  });

  throw new BadRequestError(failureReason, { provider, oauthConfigured: Boolean(config) });
}

export async function disconnectIntegration(
  userId: string,
  provider: IntegrationProvider,
): Promise<IntegrationDto> {
  return withUser(userId, async (client) => {
    const existing = await client.query<IntegrationRow>(
      'SELECT * FROM integrations WHERE user_id = $1 AND provider = $2',
      [userId, provider],
    );
    const row = existing.rows[0];
    if (!row) throw new NotFoundError('Integration not found.');
    if (row.status !== 'connected') {
      throw new BadRequestError('This integration is not connected.');
    }

    const updated = await client.query<IntegrationRow>(
      `UPDATE integrations
       SET status = 'not_connected', account_email = NULL, scopes = '[]'::jsonb,
           connected_at = NULL, last_error = NULL
       WHERE user_id = $1 AND provider = $2
       RETURNING provider, status, account_email, scopes, last_error, connected_at, updated_at`,
      [userId, provider],
    );
    await logActivity(client, {
      userId,
      type: 'integration_disconnected',
      category: 'integration',
      title: `Disconnected: ${provider.replace('_', ' ')}`,
      detail: 'Credentials revoked locally',
    });
    return mapIntegration(updated.rows[0]);
  });
}

export const connectSchema = z.object({
  provider: z.enum(DEFAULT_INTEGRATION_PROVIDERS),
});
