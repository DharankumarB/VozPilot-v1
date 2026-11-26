import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  BellRing,
  Bot,
  Check,
  Eye,
  EyeOff,
  KeyRound,
  Palette,
  Save,
  SlidersHorizontal,
  UserRound,
} from 'lucide-react';
import { api } from '../lib/api';
import type { Agent, SettingsPayload, TaskPriority, UserPreferences } from '../lib/types';
import { useAuth, errorMessage } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { Button } from '../components/ui/Button';
import { Field, Input, Select } from '../components/ui/Form';
import { Avatar } from '../components/brand/Logo';
import { EmptyState, Spinner } from '../components/ui/Feedback';
import { StatusPill } from '../components/ui/Badge';
import { ACCENT_OPTIONS, AGENT_STATUS_META, PRIORITY_META, agentIcon } from '../lib/constants';
import { cn, formatDate } from '../lib/utils';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

type TabId = 'profile' | 'appearance' | 'notifications' | 'security' | 'agents';

const TABS: { id: TabId; label: string; icon: typeof UserRound }[] = [
  { id: 'profile', label: 'Profile', icon: UserRound },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'notifications', label: 'Notifications', icon: BellRing },
  { id: 'security', label: 'Security', icon: KeyRound },
  { id: 'agents', label: 'Agent configuration', icon: Bot },
];

export function SettingsPage() {
  useDocumentTitle('Settings · VozPilot');
  const toast = useToast();
  const { user, setUser, reloadUser, preferences } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const initialTab = (searchParams.get('tab') as TabId | null) ?? 'profile';
  const [tab, setTab] = useState<TabId>(TABS.some((item) => item.id === initialTab) ? initialTab : 'profile');

  const [settings, setSettings] = useState<SettingsPayload | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Profile form
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [profileBusy, setProfileBusy] = useState(false);

  // Security form
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPasswords, setShowPasswords] = useState(false);
  const [securityBusy, setSecurityBusy] = useState(false);
  const [securityError, setSecurityError] = useState<string | null>(null);

  // Notifications
  const [notifs, setNotifs] = useState<NonNullable<UserPreferences['notifications']>>({
    approvals: true,
    taskUpdates: true,
    weeklyDigest: false,
    email: false,
    desktop: true,
  });
  const [notifBusy, setNotifBusy] = useState(false);

  // Agent defaults
  const [defaults, setDefaults] = useState<NonNullable<UserPreferences['agentDefaults']>>({
    defaultAgentId: null,
    defaultPriority: 'medium',
  });
  const [defaultsBusy, setDefaultsBusy] = useState(false);

  // Appearance
  type AccentId = NonNullable<NonNullable<UserPreferences['appearance']>['accent']>;
  type DensityId = NonNullable<NonNullable<UserPreferences['appearance']>['density']>;
  const [accent, setAccent] = useState<AccentId>('violet');
  const [density, setDensity] = useState<DensityId>('comfortable');
  const [appearanceSaved, setAppearanceSaved] = useState(true);

  useEffect(() => {
    api
      .get<SettingsPayload>('/api/settings')
      .then((data) => {
        setSettings(data);
        setName(data.profile.name);
        setEmail(data.profile.email);
        const n = data.preferences.notifications;
        if (n) setNotifs(n);
        const d = data.preferences.agentDefaults;
        if (d) setDefaults({ defaultAgentId: d.defaultAgentId ?? null, defaultPriority: d.defaultPriority ?? 'medium' });
        const a = data.preferences.appearance;
        setAccent(a?.accent ?? 'violet');
        setDensity(a?.density ?? 'comfortable');
      })
      .catch((caught) => setLoadError(errorMessage(caught)));

    api
      .get<Agent[]>('/api/agents')
      .then(setAgents)
      .catch(() => undefined);
  }, []);

  const switchTab = (id: TabId) => {
    setTab(id);
    setSearchParams(id === 'profile' ? {} : { tab: id }, { replace: true });
  };

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    if (name.trim().length < 2) {
      toast.error('Name too short', 'Use at least 2 characters.');
      return;
    }
    setProfileBusy(true);
    try {
      const data = await api.patch<{ profile: SettingsPayload['profile'] }>('/api/settings/profile', {
        name: name.trim(),
        email: email.trim(),
      });
      setUser(data.profile);
      await reloadUser();
      setSettings((current) => (current ? { ...current, profile: data.profile } : current));
      toast.success('Profile saved');
    } catch (caught) {
      toast.error('Could not save profile', errorMessage(caught));
    } finally {
      setProfileBusy(false);
    }
  };

  const applyAppearance = (nextAccent: typeof accent, nextDensity: typeof density) => {
    setAccent(nextAccent);
    setDensity(nextDensity);
    setAppearanceSaved(false);
    // Apply live…
    const palette = { violet: ['#7c5cff', '#6544e8'], gold: ['#d9a94e', '#b98a36'], teal: ['#2dd4bf', '#14b8a6'], rose: ['#fb7185', '#f43f5e'] } as const;
    document.documentElement.style.setProperty('--accent', palette[nextAccent][0]);
    document.documentElement.style.setProperty('--accent-strong', palette[nextAccent][1]);
    document.documentElement.dataset.density = nextDensity;
    // …and persist.
    api
      .patch<{ preferences: UserPreferences }>('/api/settings/appearance', { accent: nextAccent, density: nextDensity })
      .then(() => {
        setAppearanceSaved(true);
        void reloadUser();
      })
      .catch((caught) => {
        toast.error('Could not save appearance', errorMessage(caught));
        setAppearanceSaved(true);
      });
  };

  const saveNotifications = async (event: FormEvent) => {
    event.preventDefault();
    setNotifBusy(true);
    try {
      await api.patch<{ preferences: UserPreferences }>('/api/settings/notifications', notifs);
      await reloadUser();
      toast.success('Notification preferences saved');
    } catch (caught) {
      toast.error('Could not save preferences', errorMessage(caught));
    } finally {
      setNotifBusy(false);
    }
  };

  const saveDefaults = async (event: FormEvent) => {
    event.preventDefault();
    setDefaultsBusy(true);
    try {
      await api.patch<{ preferences: UserPreferences }>('/api/settings/agent-defaults', defaults);
      await reloadUser();
      toast.success('Agent defaults saved');
    } catch (caught) {
      toast.error('Could not save defaults', errorMessage(caught));
    } finally {
      setDefaultsBusy(false);
    }
  };

  const changePassword = async (event: FormEvent) => {
    event.preventDefault();
    setSecurityError(null);
    if (newPassword.length < 8) {
      setSecurityError('New password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setSecurityError('New passwords do not match.');
      return;
    }
    setSecurityBusy(true);
    try {
      await api.post('/api/auth/change-password', { currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      toast.success('Password changed', 'Use your new password next time you sign in.');
    } catch (caught) {
      setSecurityError(errorMessage(caught));
    } finally {
      setSecurityBusy(false);
    }
  };

  if (loadError && !settings) {
    return (
      <EmptyState
        title="Couldn't load settings"
        description={loadError}
        action={
          <Button onClick={() => window.location.reload()}>
            Retry
          </Button>
        }
      />
    );
  }

  if (!settings) {
    return (
      <div className="flex justify-center py-32">
        <Spinner size={24} />
      </div>
    );
  }

  return (
    <div className="anim-enter flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-mist-100 sm:text-2xl">Settings</h1>
        <p className="mt-1 text-sm text-mist-400">Profile, workspace appearance, notifications and security.</p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[220px_1fr]">
        {/* Tab rail */}
        <nav className="flex gap-1.5 overflow-x-auto rounded-2xl border border-white/8 bg-void-900/60 p-1.5 lg:flex-col lg:overflow-visible">
          {TABS.map((item) => {
            const Icon = item.icon;
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => switchTab(item.id)}
                className={cn(
                  'focus-ring flex shrink-0 items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-left text-xs font-medium transition lg:w-full',
                  active ? 'bg-[var(--accent-soft)] text-mist-100' : 'text-mist-400 hover:bg-white/5 hover:text-mist-200',
                )}
              >
                <Icon size={15} className={active ? 'text-[var(--accent)]' : 'text-mist-500'} />
                <span className="whitespace-nowrap">{item.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Panels */}
        <div className="min-w-0">
          {tab === 'profile' ? (
            <section className="glass rounded-2xl p-6">
              <div className="mb-5 flex items-center gap-4">
                <Avatar name={name || '?'} size={52} />
                <div>
                  <h2 className="text-sm font-semibold text-mist-100">Your profile</h2>
                  <p className="mt-0.5 text-xs text-mist-500">
                    Member since {formatDate(settings.profile.createdAt)} · role: {settings.profile.role}
                  </p>
                </div>
              </div>
              <form onSubmit={saveProfile} className="flex max-w-lg flex-col gap-4">
                <Field label="Full name" htmlFor="set-name">
                  <Input id="set-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required />
                </Field>
                <Field label="Email" htmlFor="set-email" hint="Used to sign in. Changing it takes effect immediately.">
                  <Input
                    id="set-email"
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    maxLength={254}
                    required
                  />
                </Field>
                <div className="flex justify-end">
                  <Button type="submit" variant="primary" loading={profileBusy} icon={<Save size={15} />}>
                    Save profile
                  </Button>
                </div>
              </form>
            </section>
          ) : null}

          {tab === 'appearance' ? (
            <section className="glass rounded-2xl p-6">
              <div className="mb-5">
                <h2 className="text-sm font-semibold text-mist-100">Appearance</h2>
                <p className="mt-0.5 text-xs text-mist-500">
                  Changes apply instantly and persist to your workspace.{' '}
                  <span className={cn('font-medium', appearanceSaved ? 'text-verdant-400' : 'text-gild-400')}>
                    {appearanceSaved ? 'Saved ✓' : 'Saving…'}
                  </span>
                </p>
              </div>

              <div className="flex max-w-lg flex-col gap-6">
                <div>
                  <p className="mb-2.5 text-xs font-medium text-mist-300">Accent colour</p>
                  <div className="flex flex-wrap gap-3">
                    {ACCENT_OPTIONS.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => applyAppearance(option.id, density)}
                        aria-pressed={accent === option.id}
                        className={cn(
                          'focus-ring flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-xs font-medium transition',
                          accent === option.id
                            ? 'border-[var(--accent)]/60 bg-[var(--accent-faint)] text-mist-100'
                            : 'border-white/10 bg-white/4 text-mist-400 hover:border-white/20',
                        )}
                      >
                        <span className="h-4 w-4 rounded-full ring-1 ring-white/20" style={{ backgroundColor: option.swatch }} />
                        {option.label}
                        {accent === option.id ? <Check size={13} className="text-[var(--accent)]" /> : null}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <p className="mb-2.5 text-xs font-medium text-mist-300">Interface density</p>
                  <div className="flex gap-3">
                    {(['comfortable', 'compact'] as const).map((option) => (
                      <button
                        key={option}
                        type="button"
                        onClick={() => applyAppearance(accent, option)}
                        aria-pressed={density === option}
                        className={cn(
                          'focus-ring flex-1 rounded-xl border px-4 py-3 text-left transition',
                          density === option
                            ? 'border-[var(--accent)]/60 bg-[var(--accent-faint)]'
                            : 'border-white/10 bg-white/4 hover:border-white/20',
                        )}
                      >
                        <span className="block text-xs font-medium text-mist-200">
                          {option === 'comfortable' ? 'Comfortable' : 'Compact'}
                        </span>
                        <span className="mt-0.5 block text-[11px] text-mist-500">
                          {option === 'comfortable' ? 'More breathing room' : 'Tighter spacing'}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </section>
          ) : null}

          {tab === 'notifications' ? (
            <section className="glass rounded-2xl p-6">
              <div className="mb-5">
                <h2 className="text-sm font-semibold text-mist-100">Notification preferences</h2>
                <p className="mt-0.5 text-xs leading-relaxed text-mist-500">
                  Choose what matters to you. In-app signals (pending approvals, due tasks) are live now;
                  email and desktop delivery activate as integrations connect.
                </p>
              </div>
              <form onSubmit={saveNotifications} className="flex max-w-lg flex-col gap-4">
                {(
                  [
                    ['approvals', 'Approval requests', 'When a task is waiting for your decision'],
                    ['taskUpdates', 'Task updates', 'Status changes on work you follow'],
                    ['weeklyDigest', 'Weekly digest', 'A summary of completions and pending work'],
                    ['desktop', 'Desktop alerts', 'Browser notifications while VozPilot is open'],
                    ['email', 'Email alerts', 'Requires a configured mail integration (Phase 2)'],
                  ] as [keyof typeof notifs, string, string][]
                ).map(([key, label, description]) => (
                  <label
                    key={key}
                    className="flex cursor-pointer items-start justify-between gap-4 rounded-xl border border-white/8 px-4 py-3.5 transition hover:border-white/14"
                  >
                    <span>
                      <span className="block text-xs font-medium text-mist-200">{label}</span>
                      <span className="mt-0.5 block text-[11px] text-mist-500">{description}</span>
                    </span>
                    <span className="relative mt-0.5 inline-flex shrink-0">
                      <input
                        type="checkbox"
                        checked={notifs[key] ?? false}
                        onChange={(event) => setNotifs((current) => ({ ...current, [key]: event.target.checked }))}
                        className="peer sr-only"
                      />
                      <span className="h-5 w-9 rounded-full bg-white/12 transition peer-checked:bg-[var(--accent)]" />
                      <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform peer-checked:translate-x-4" />
                    </span>
                  </label>
                ))}
                <div className="flex justify-end">
                  <Button type="submit" variant="primary" loading={notifBusy} icon={<Save size={15} />}>
                    Save preferences
                  </Button>
                </div>
              </form>
            </section>
          ) : null}

          {tab === 'security' ? (
            <section className="glass rounded-2xl p-6">
              <div className="mb-5">
                <h2 className="text-sm font-semibold text-mist-100">Change password</h2>
                <p className="mt-0.5 text-xs text-mist-500">
                  Passwords are hashed with bcrypt (12 rounds). Session cookies stay httpOnly.
                </p>
              </div>
              <form onSubmit={changePassword} className="flex max-w-lg flex-col gap-4">
                {securityError ? (
                  <div className="rounded-xl border border-rosh-500/30 bg-rosh-500/10 px-3.5 py-2.5 text-xs text-rosh-400" role="alert">
                    {securityError}
                  </div>
                ) : null}
                <Field label="Current password" htmlFor="cur-pw">
                  <div className="relative">
                    <Input
                      id="cur-pw"
                      type={showPasswords ? 'text' : 'password'}
                      value={currentPassword}
                      onChange={(event) => setCurrentPassword(event.target.value)}
                      autoComplete="current-password"
                      required
                    />
                  </div>
                </Field>
                <Field label="New password" htmlFor="new-pw" hint="At least 8 characters.">
                  <Input
                    id="new-pw"
                    type={showPasswords ? 'text' : 'password'}
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.target.value)}
                    autoComplete="new-password"
                    required
                  />
                </Field>
                <Field label="Confirm new password" htmlFor="conf-pw">
                  <Input
                    id="conf-pw"
                    type={showPasswords ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    autoComplete="new-password"
                    required
                  />
                </Field>
                <div className="flex items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => setShowPasswords((value) => !value)}
                    className="focus-ring inline-flex items-center gap-1.5 rounded-lg text-xs text-mist-400 hover:text-mist-200"
                  >
                    {showPasswords ? <EyeOff size={13} /> : <Eye size={13} />}
                    {showPasswords ? 'Hide passwords' : 'Show passwords'}
                  </button>
                  <Button
                    type="submit"
                    variant="primary"
                    loading={securityBusy}
                    disabled={!currentPassword || !newPassword}
                    icon={<KeyRound size={15} />}
                  >
                    Change password
                  </Button>
                </div>
              </form>
            </section>
          ) : null}

          {tab === 'agents' ? (
            <section className="glass rounded-2xl p-6">
              <div className="mb-5">
                <h2 className="text-sm font-semibold text-mist-100">Agent configuration defaults</h2>
                <p className="mt-0.5 text-xs text-mist-500">
                  New task forms open with these values — you can always override them per task.
                </p>
              </div>

              <form onSubmit={saveDefaults} className="flex max-w-lg flex-col gap-4">
                <Field label="Default agent" htmlFor="def-agent" hint="Preselected when creating a task.">
                  <Select
                    id="def-agent"
                    value={defaults.defaultAgentId ?? ''}
                    onChange={(event) => setDefaults((current) => ({ ...current, defaultAgentId: event.target.value || null }))}
                  >
                    <option value="">No default — ask each time</option>
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Default priority" htmlFor="def-priority">
                  <Select
                    id="def-priority"
                    value={defaults.defaultPriority ?? 'medium'}
                    onChange={(event) =>
                      setDefaults((current) => ({ ...current, defaultPriority: event.target.value as TaskPriority }))
                    }
                  >
                    {(['low', 'medium', 'high', 'critical'] as TaskPriority[]).map((priority) => (
                      <option key={priority} value={priority}>
                        {PRIORITY_META[priority].label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <div className="flex justify-end">
                  <Button type="submit" variant="primary" loading={defaultsBusy} icon={<Save size={15} />}>
                    Save defaults
                  </Button>
                </div>
              </form>

              {/* Workforce overview with statuses */}
              <div className="mt-7 border-t border-white/8 pt-5">
                <div className="mb-3 flex items-center gap-2">
                  <SlidersHorizontal size={14} className="text-gild-400" />
                  <h3 className="text-xs font-semibold uppercase tracking-[0.1em] text-mist-400">
                    Workforce status
                  </h3>
                </div>
                {agents.length === 0 ? (
                  <p className="text-xs text-mist-500">No agents loaded.</p>
                ) : (
                  <ul className="grid gap-2 sm:grid-cols-2">
                    {agents.map((agent) => {
                      const Icon = agentIcon(agent.icon);
                      return (
                        <li key={agent.id} className="flex items-center gap-2.5 rounded-xl border border-white/8 bg-white/3 px-3.5 py-2.5">
                          <Icon size={14} className="shrink-0 text-[var(--accent)]" />
                          <span className="min-w-0 flex-1 truncate text-xs font-medium text-mist-200">{agent.name}</span>
                          <StatusPill {...AGENT_STATUS_META[agent.status]} />
                        </li>
                      );
                    })}
                  </ul>
                )}
                <p className="mt-3 text-[11px] text-mist-600">
                  Change individual agent status from the Agent Hub. User: {user?.email}
                </p>
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
