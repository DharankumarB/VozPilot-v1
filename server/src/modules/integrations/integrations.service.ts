import crypto from 'crypto';
import { z } from 'zod';
import { env } from '../../config/env';
import { withUser } from '../../db/pool';
import { logActivity } from '../../lib/activity';
import { BadRequestError, NotFoundError } from '../../lib/errors';
import { iso } from '../../lib/serialize';
import { encryptToken } from '../../lib/tokenCrypto';
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
  oauthConfigured?: boolean;
  authUrl?: string | null;
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

const MIN_PROVIDER_SCOPES: Record<IntegrationProvider, string[]> = {
  gmail: [
    'openid',
    'email',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.compose',
    'https://www.googleapis.com/auth/gmail.send',
  ],
  google_calendar: [
    'openid',
    'email',
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/calendar.events',
  ],
  google_drive: [
    'openid',
    'email',
    'https://www.googleapis.com/auth/drive.readonly',
  ],
  github: ['read:user', 'user:email', 'repo'],
  notion: [],
};

function oauthCredentials(provider: IntegrationProvider): { clientId: string; clientSecret: string } | null {
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

function mapIntegration(row: IntegrationRow): IntegrationDto {
  return {
    provider: row.provider,
    status: row.status,
    accountEmail: row.account_email,
    scopes: row.scopes ?? [],
    lastError: row.last_error,
    connectedAt: iso(row.connected_at),
    updatedAt: row.updated_at.toISOString(),
    oauthConfigured: Boolean(oauthCredentials(row.provider)),
  };
}

export function isProvider(value: string): value is IntegrationProvider {
  return (DEFAULT_INTEGRATION_PROVIDERS as readonly string[]).includes(value);
}

export async function listIntegrations(userId: string): Promise<IntegrationDto[]> {
  return withUser(userId, async (client) => {
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

function buildPkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function resolveOrigin(requestOrigin?: string): string {
  if (env.APP_BASE_URL && env.APP_BASE_URL.trim()) {
    return env.APP_BASE_URL.trim().replace(/\/+$/, '');
  }
  if (requestOrigin && /^https?:\/\//i.test(requestOrigin)) {
    return requestOrigin.replace(/\/+$/, '');
  }
  return `http://localhost:${env.PORT}`;
}

/**
 * Start a real OAuth 2.0 flow when server client credentials are configured,
 * or fail honestly (keeping status `not_connected`) when they are absent.
 */
export async function connectIntegration(
  userId: string,
  provider: IntegrationProvider,
  requestOrigin?: string,
): Promise<IntegrationDto> {
  const creds = oauthCredentials(provider);
  if (!creds) {
    const failureReason =
      'OAuth credentials for this provider are not configured on the server. Add them to the server environment (see .env.example), then try again.';

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

    throw new BadRequestError(failureReason, { provider, oauthConfigured: false });
  }

  const state = crypto.randomBytes(24).toString('hex');
  const { verifier, challenge } = buildPkcePair();
  const baseOrigin = resolveOrigin(requestOrigin);
  const redirectUri = `${baseOrigin}/api/integrations/oauth/${provider}/callback`;
  const scopes = MIN_PROVIDER_SCOPES[provider];

  let authUrl: URL;
  if (provider === 'gmail' || provider === 'google_calendar' || provider === 'google_drive') {
    authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', creds.clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', scopes.join(' '));
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');
    authUrl.searchParams.set('include_granted_scopes', 'true');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
  } else if (provider === 'github') {
    authUrl = new URL('https://github.com/login/oauth/authorize');
    authUrl.searchParams.set('client_id', creds.clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('scope', scopes.join(' '));
    authUrl.searchParams.set('state', state);
  } else {
    authUrl = new URL('https://api.notion.com/v1/oauth/authorize');
    authUrl.searchParams.set('client_id', creds.clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('owner', 'user');
    authUrl.searchParams.set('state', state);
  }

  return withUser(userId, async (client) => {
    await client.query('DELETE FROM oauth_states WHERE expires_at < now()');
    await client.query(
      `INSERT INTO oauth_states (state, user_id, provider, redirect_uri, scopes, code_verifier, expires_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, now() + interval '15 minutes')`,
      [state, userId, provider, redirectUri, JSON.stringify(scopes), verifier],
    );

    const current = await client.query<IntegrationRow>(
      `SELECT provider, status, account_email, scopes, last_error, connected_at, updated_at
       FROM integrations WHERE user_id = $1 AND provider = $2`,
      [userId, provider],
    );
    const dto = mapIntegration(
      current.rows[0] ?? {
        provider,
        status: 'not_connected',
        account_email: null,
        scopes: [],
        last_error: null,
        connected_at: null,
        updated_at: new Date(),
      },
    );
    dto.authUrl = authUrl.toString();
    return dto;
  });
}

/**
 * Complete the OAuth 2.0 authorization code exchange, verify identity,
 * encrypt tokens at rest (`AES-256-GCM`), and mark the integration connected.
 */
export async function completeOAuthCallback(
  userId: string,
  provider: IntegrationProvider,
  code: string,
  state: string,
): Promise<IntegrationDto> {
  const creds = oauthCredentials(provider);
  if (!creds) {
    throw new BadRequestError('OAuth credentials are not configured on the server.');
  }

  const stateRecord = await withUser(userId, async (client) => {
    const res = await client.query<{
      state: string;
      provider: string;
      redirect_uri: string;
      scopes: string[];
      code_verifier: string | null;
      expires_at: Date;
    }>('DELETE FROM oauth_states WHERE state = $1 AND user_id = $2 RETURNING *', [state, userId]);
    return res.rows[0] ?? null;
  });

  if (!stateRecord || stateRecord.provider !== provider || stateRecord.expires_at.getTime() < Date.now()) {
    throw new BadRequestError('Invalid or expired OAuth state. Please try connecting again.');
  }

  let accessToken = '';
  let refreshToken: string | null = null;
  let expiresAt: Date | null = null;
  let accountEmail: string | null = null;
  let grantedScopes: string[] = stateRecord.scopes ?? [];

  if (provider === 'gmail' || provider === 'google_calendar' || provider === 'google_drive') {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        redirect_uri: stateRecord.redirect_uri,
        grant_type: 'authorization_code',
        ...(stateRecord.code_verifier ? { code_verifier: stateRecord.code_verifier } : {}),
      }),
    });
    if (!tokenRes.ok) {
      throw new BadRequestError('Google rejected the OAuth authorization code.');
    }
    const tokenJson = (await tokenRes.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };
    if (!tokenJson.access_token) {
      throw new BadRequestError('Google token response did not include an access token.');
    }
    accessToken = tokenJson.access_token;
    refreshToken = tokenJson.refresh_token ?? null;
    if (tokenJson.expires_in) {
      expiresAt = new Date(Date.now() + Number(tokenJson.expires_in) * 1000);
    }
    if (tokenJson.scope) {
      grantedScopes = tokenJson.scope.split(/\s+/).filter(Boolean);
    }

    const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (userRes.ok) {
      const profile = (await userRes.json()) as { email?: string };
      accountEmail = profile.email ?? null;
    }
  } else if (provider === 'github') {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        code,
        redirect_uri: stateRecord.redirect_uri,
      }),
    });
    if (!tokenRes.ok) {
      throw new BadRequestError('GitHub rejected the OAuth authorization code.');
    }
    const tokenJson = (await tokenRes.json()) as { access_token?: string; scope?: string };
    if (!tokenJson.access_token) {
      throw new BadRequestError('GitHub token response did not include an access token.');
    }
    accessToken = tokenJson.access_token;
    if (tokenJson.scope) {
      grantedScopes = tokenJson.scope.split(',').map((s) => s.trim()).filter(Boolean);
    }
    const ghUser = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json' },
    });
    if (ghUser.ok) {
      const profile = (await ghUser.json()) as { email?: string | null; login?: string };
      accountEmail = profile.email || profile.login || null;
    }
  } else {
    const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
    const tokenRes = await fetch('https://api.notion.com/v1/oauth/token', {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: stateRecord.redirect_uri,
      }),
    });
    if (!tokenRes.ok) {
      throw new BadRequestError('Notion rejected the OAuth authorization code.');
    }
    const tokenJson = (await tokenRes.json()) as {
      access_token?: string;
      workspace_name?: string;
    };
    if (!tokenJson.access_token) {
      throw new BadRequestError('Notion token response did not include an access token.');
    }
    accessToken = tokenJson.access_token;
    accountEmail = tokenJson.workspace_name ?? 'Notion Workspace';
  }

  const encAccess = encryptToken(accessToken);
  const encRefresh = refreshToken ? encryptToken(refreshToken) : null;

  return withUser(userId, async (client) => {
    const updated = await client.query<IntegrationRow>(
      `INSERT INTO integrations
         (user_id, provider, status, account_email, scopes,
          encrypted_access_token, encrypted_refresh_token, token_expires_at,
          last_error, connected_at)
       VALUES ($1, $2, 'connected', $3, $4::jsonb, $5, $6, $7, NULL, now())
       ON CONFLICT (user_id, provider)
       DO UPDATE SET
         status = 'connected',
         account_email = EXCLUDED.account_email,
         scopes = EXCLUDED.scopes,
         encrypted_access_token = EXCLUDED.encrypted_access_token,
         encrypted_refresh_token = COALESCE(EXCLUDED.encrypted_refresh_token, integrations.encrypted_refresh_token),
         token_expires_at = EXCLUDED.token_expires_at,
         last_error = NULL,
         connected_at = now()
       RETURNING provider, status, account_email, scopes, last_error, connected_at, updated_at`,
      [userId, provider, accountEmail, JSON.stringify(grantedScopes), encAccess, encRefresh, expiresAt],
    );
    await logActivity(client, {
      userId,
      type: 'integration_connected',
      category: 'integration',
      title: `Connected: ${provider.replace('_', ' ')}`,
      detail: accountEmail ? `Authorized as ${accountEmail}` : 'OAuth 2.0 verified',
    });
    return mapIntegration(updated.rows[0]);
  });
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
       SET status = 'not_connected',
           account_email = NULL,
           scopes = '[]'::jsonb,
           encrypted_access_token = NULL,
           encrypted_refresh_token = NULL,
           token_expires_at = NULL,
           provider_metadata = '{}'::jsonb,
           connected_at = NULL,
           last_error = NULL
       WHERE user_id = $1 AND provider = $2
       RETURNING provider, status, account_email, scopes, last_error, connected_at, updated_at`,
      [userId, provider],
    );
    await logActivity(client, {
      userId,
      type: 'integration_disconnected',
      category: 'integration',
      title: `Disconnected: ${provider.replace('_', ' ')}`,
      detail: 'Encrypted OAuth tokens purged locally',
    });
    return mapIntegration(updated.rows[0]);
  });
}

export const connectSchema = z.object({
  provider: z.enum(DEFAULT_INTEGRATION_PROVIDERS),
});
