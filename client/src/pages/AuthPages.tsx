import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowRight, Bot, ListTodo, Lock, Mail, ShieldCheck, Sparkles, UserRound } from 'lucide-react';
import { errorMessage, useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { Button } from '../components/ui/Button';
import { Field, Input } from '../components/ui/Form';
import { LogoMark } from '../components/brand/Logo';

/** Shared brand panel used by login & register (desktop). */
function BrandPanel() {
  const points = [
    { icon: Sparkles, title: 'Nine specialist agents', body: 'VozCore plus eight domain agents, ready to configure.' },
    { icon: ListTodo, title: 'Real task & approval flow', body: 'Create, assign, gate and track work with PostgreSQL persistence.' },
    { icon: ShieldCheck, title: 'Isolated & secure', body: 'Cookie sessions, hashed passwords, per-workspace data policies.' },
  ];
  return (
    <div className="relative hidden overflow-hidden rounded-3xl border border-white/8 bg-void-900/70 p-10 lg:flex lg:flex-col lg:justify-between">
      <div
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          background:
            'radial-gradient(600px 320px at 20% 0%, color-mix(in srgb, var(--accent) 16%, transparent), transparent 65%), radial-gradient(500px 300px at 90% 100%, color-mix(in srgb, var(--gold) 8%, transparent), transparent 60%)',
        }}
        aria-hidden="true"
      />
      <div className="relative">
        <div className="flex items-center gap-3">
          <LogoMark size={40} />
          <div>
            <p className="text-lg font-semibold tracking-tight text-mist-100">VozPilot</p>
            <p className="text-[11px] uppercase tracking-[0.2em] text-mist-500">VozLook Studios</p>
          </div>
        </div>
        <h1 className="mt-10 max-w-md text-2xl font-semibold leading-snug tracking-tight text-mist-100">
          Your autonomous AI workforce,
          <span className="text-[var(--accent)]"> under your command.</span>
        </h1>
        <p className="mt-3 max-w-md text-sm leading-relaxed text-mist-400">
          VozPilot centralises specialised agents behind one manager. Phase 1 delivers the full
          foundation — orchestration connects in Phase 2.
        </p>
        <ul className="mt-9 flex flex-col gap-5">
          {points.map((point) => (
            <li key={point.title} className="flex gap-3.5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-[var(--accent)]">
                <point.icon size={16} />
              </span>
              <div>
                <p className="text-sm font-medium text-mist-200">{point.title}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-mist-500">{point.body}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
      <p className="relative text-xs text-mist-600">
        Phase 1 · Application foundation · AI execution arrives in Phase 2
      </p>
    </div>
  );
}

function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-2">
      <div className="flex flex-col justify-center px-6 py-12 sm:px-12 lg:px-16">
        <div className="mx-auto w-full max-w-sm">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <LogoMark size={36} />
            <div>
              <p className="text-base font-semibold text-mist-100">VozPilot</p>
              <p className="text-[10px] uppercase tracking-[0.2em] text-mist-500">VozLook Studios</p>
            </div>
          </div>
          {children}
        </div>
      </div>
      <div className="hidden p-6 lg:block">
        <BrandPanel />
      </div>
    </div>
  );
}

export function LoginPage() {
  const { login } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }
    setBusy(true);
    try {
      await login(email.trim(), password);
      const destination = (location.state as { from?: string } | null)?.from ?? '/';
      navigate(destination, { replace: true });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell>
      <p className="micro-label">Welcome back</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-mist-100">Sign in to VozPilot</h1>
      <p className="mt-1.5 text-sm text-mist-400">Access your agents, tasks and approvals.</p>

      <form onSubmit={onSubmit} className="mt-8 flex flex-col gap-4" noValidate>
        {error ? (
          <div className="rounded-xl border border-rosh-500/30 bg-rosh-500/10 px-3.5 py-2.5 text-xs text-rosh-400" role="alert">
            {error}
          </div>
        ) : null}

        <Field label="Email" htmlFor="login-email">
          <div className="relative">
            <Mail size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-mist-500" />
            <Input
              id="login-email"
              type="email"
              autoComplete="email"
              placeholder="you@company.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="pl-9"
              required
            />
          </div>
        </Field>

        <Field label="Password" htmlFor="login-password">
          <div className="relative">
            <Lock size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-mist-500" />
            <Input
              id="login-password"
              type="password"
              autoComplete="current-password"
              placeholder="••••••••"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="pl-9"
              required
            />
          </div>
        </Field>

        <Button type="submit" variant="primary" size="lg" loading={busy} className="mt-2" icon={<ArrowRight size={16} />}>
          Sign in
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-mist-400">
        New to VozPilot?{' '}
        <Link to="/register" className="focus-ring rounded font-medium text-[var(--accent)] hover:underline">
          Create your workspace
        </Link>
      </p>
    </AuthShell>
  );
}

export function RegisterPage() {
  const { register } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (name.trim().length < 2) {
      setError('Please enter your full name (at least 2 characters).');
      return;
    }
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) {
      setError('Please enter a valid email address.');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    setBusy(true);
    try {
      await register(name.trim(), email.trim(), password);
      toast.success('Workspace created', 'Your nine agent profiles are ready to configure.');
      navigate('/', { replace: true });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell>
      <p className="micro-label">Get started</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-mist-100">Create your workspace</h1>
      <p className="mt-1.5 text-sm text-mist-400">
        You'll get nine agent profiles, tasks, workflows and approvals — all persisted.
      </p>

      <form onSubmit={onSubmit} className="mt-8 flex flex-col gap-4" noValidate>
        {error ? (
          <div className="rounded-xl border border-rosh-500/30 bg-rosh-500/10 px-3.5 py-2.5 text-xs text-rosh-400" role="alert">
            {error}
          </div>
        ) : null}

        <Field label="Full name" htmlFor="register-name">
          <div className="relative">
            <UserRound size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-mist-500" />
            <Input
              id="register-name"
              autoComplete="name"
              placeholder="Ada Lovelace"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="pl-9"
              required
            />
          </div>
        </Field>

        <Field label="Email" htmlFor="register-email">
          <div className="relative">
            <Mail size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-mist-500" />
            <Input
              id="register-email"
              type="email"
              autoComplete="email"
              placeholder="you@company.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="pl-9"
              required
            />
          </div>
        </Field>

        <Field
          label="Password"
          htmlFor="register-password"
          hint="At least 8 characters."
        >
          <div className="relative">
            <Lock size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-mist-500" />
            <Input
              id="register-password"
              type="password"
              autoComplete="new-password"
              placeholder="••••••••"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="pl-9"
              required
            />
          </div>
        </Field>

        <Button type="submit" variant="primary" size="lg" loading={busy} className="mt-2" icon={<Bot size={16} />}>
          Create workspace
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-mist-400">
        Already have an account?{' '}
        <Link to="/login" className="focus-ring rounded font-medium text-[var(--accent)] hover:underline">
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}
