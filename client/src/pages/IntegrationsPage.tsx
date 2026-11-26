import { useCallback, useEffect, useState } from 'react';
import { Info, Plug, RefreshCw, Unlink } from 'lucide-react';
import { api } from '../lib/api';
import type { Integration, IntegrationProvider } from '../lib/types';
import { useToast } from '../context/ToastContext';
import { errorMessage } from '../context/AuthContext';
import { PageHeader } from '../components/PageHeader';
import { Button } from '../components/ui/Button';
import { StatusPill } from '../components/ui/Badge';
import { EmptyState, ListSkeleton } from '../components/ui/Feedback';
import { PROVIDER_META } from '../lib/constants';
import { cn, formatRelative } from '../lib/utils';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

const STATUS_DISPLAY: Record<Integration['status'], { label: string; text: string; bg: string; dot: string }> = {
  connected: { label: 'Connected', text: 'text-verdant-400', bg: 'bg-verdant-500/12', dot: 'bg-verdant-500' },
  not_connected: { label: 'Not connected', text: 'text-mist-400', bg: 'bg-white/6', dot: 'bg-mist-500' },
  error: { label: 'Error', text: 'text-rosh-400', bg: 'bg-rosh-500/12', dot: 'bg-rosh-500' },
};

export function IntegrationsPage() {
  useDocumentTitle('Integrations · VozPilot');
  const toast = useToast();

  const [integrations, setIntegrations] = useState<Integration[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyProvider, setBusyProvider] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    api
      .get<Integration[]>('/api/integrations')
      .then(setIntegrations)
      .catch((caught) => setLoadError(errorMessage(caught)));
  }, []);

  useEffect(load, [load]);

  const connect = async (provider: IntegrationProvider) => {
    setBusyProvider(provider);
    try {
      await api.post<Integration>(`/api/integrations/${provider}/connect`);
      // The server never reaches this in Phase 1 — connect always reports the
      // honest failure state — but keep the flow truthful if that changes.
      load();
    } catch (caught) {
      const message = errorMessage(caught);
      toast.error(`${PROVIDER_META[provider].name}: not connected`, message);
      load();
    } finally {
      setBusyProvider(null);
    }
  };

  const disconnect = async (provider: IntegrationProvider) => {
    setBusyProvider(provider);
    try {
      await api.post<Integration>(`/api/integrations/${provider}/disconnect`);
      toast.success(`${PROVIDER_META[provider].name} disconnected`);
      load();
    } catch (caught) {
      toast.error('Could not disconnect', errorMessage(caught));
    } finally {
      setBusyProvider(null);
    }
  };

  return (
    <div className="anim-enter flex flex-col gap-5">
      <PageHeader
        title="Integrations"
        subtitle="External services your agents will operate once OAuth flows are configured."
        actions={
          <Button variant="secondary" size="sm" icon={<RefreshCw size={13} />} onClick={load}>
            Refresh status
          </Button>
        }
      />

      {/* Honesty notice */}
      <div className="flex items-start gap-3 rounded-2xl border border-azure-500/25 bg-azure-500/8 px-4 py-3.5">
        <Info size={15} className="mt-0.5 shrink-0 text-azure-400" />
        <div className="text-xs leading-relaxed text-mist-400">
          <strong className="font-semibold text-azure-400">Honest connection status:</strong> a service
          shows <em>Connected</em> only after its real OAuth flow succeeds. Credentials live exclusively
          on the server (environment variables) and are never sent to the browser. Until credentials and
          callbacks are configured, every provider correctly reports <em>Not connected</em>.
        </div>
      </div>

      {loadError && !integrations ? (
        <EmptyState title="Couldn't load integrations" description={loadError} action={<Button onClick={load}>Retry</Button>} />
      ) : !integrations ? (
        <ListSkeleton rows={3} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {integrations.map((integration) => {
            const meta = PROVIDER_META[integration.provider];
            const Icon = meta.icon;
            const display = STATUS_DISPLAY[integration.status];
            const busy = busyProvider === integration.provider;
            return (
              <article key={integration.provider} className="glass flex flex-col rounded-2xl p-5">
                <div className="flex items-start justify-between gap-3">
                  <span
                    className={cn(
                      'flex h-11 w-11 items-center justify-center rounded-xl border',
                      integration.status === 'connected'
                        ? 'border-verdant-500/30 bg-verdant-500/10 text-verdant-400'
                        : 'border-white/10 bg-white/5 text-mist-300',
                    )}
                  >
                    <Icon size={20} />
                  </span>
                  <StatusPill {...display} />
                </div>

                <div className="mt-3.5">
                  <div className="flex items-baseline gap-2">
                    <h2 className="text-[15px] font-semibold text-mist-100">{meta.name}</h2>
                    <span className="text-[10.5px] uppercase tracking-wider text-mist-600">{meta.vendor}</span>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-mist-400">{meta.blurb}</p>
                </div>

                {integration.accountEmail ? (
                  <p className="mt-3 rounded-lg bg-white/4 px-3 py-2 text-[11.5px] text-mist-300">
                    Signed in as {integration.accountEmail}
                  </p>
                ) : null}

                {integration.lastError ? (
                  <p className="mt-3 rounded-lg border border-lume-500/25 bg-lume-500/8 px-3 py-2 text-[11.5px] leading-relaxed text-lume-400/90">
                    {integration.lastError}
                  </p>
                ) : null}

                <div className="mt-4 flex items-center justify-between border-t border-white/7 pt-3.5">
                  <span className="text-[11px] text-mist-600">
                    {integration.status === 'connected'
                      ? `Connected ${formatRelative(integration.connectedAt)}`
                      : `Checked ${formatRelative(integration.updatedAt)}`}
                  </span>
                  {integration.status === 'connected' ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={<Unlink size={13} />}
                      loading={busy}
                      onClick={() => void disconnect(integration.provider)}
                    >
                      Disconnect
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="primary"
                      icon={<Plug size={13} />}
                      loading={busy}
                      onClick={() => void connect(integration.provider)}
                    >
                      Connect
                    </Button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* Setup guide */}
      <div className="glass rounded-2xl p-5">
        <h2 className="text-sm font-semibold text-mist-100">Enabling a real connection</h2>
        <ol className="mt-3 flex flex-col gap-2 text-xs leading-relaxed text-mist-400 sm:grid sm:grid-cols-3 sm:gap-4">
          <li className="rounded-xl border border-white/8 bg-white/3 px-3.5 py-3">
            <span className="mb-1 block font-mono text-[10px] font-bold text-[var(--accent)]">STEP 1</span>
            Register an OAuth application with the provider (Google, GitHub or Notion) and note the
            client ID and secret.
          </li>
          <li className="rounded-xl border border-white/8 bg-white/3 px-3.5 py-3">
            <span className="mb-1 block font-mono text-[10px] font-bold text-[var(--accent)]">STEP 2</span>
            Add them to the server <code className="font-mono text-[11px] text-gild-400">.env</code>{' '}
            file — see <code className="font-mono text-[11px] text-gild-400">.env.example</code>.
          </li>
          <li className="rounded-xl border border-white/8 bg-white/3 px-3.5 py-3">
            <span className="mb-1 block font-mono text-[10px] font-bold text-[var(--accent)]">STEP 3</span>
            Add the authorization callback to the server .env — the connection activates as soon
            as the OAuth flow is wired up.
          </li>
        </ol>
      </div>
    </div>
  );
}
