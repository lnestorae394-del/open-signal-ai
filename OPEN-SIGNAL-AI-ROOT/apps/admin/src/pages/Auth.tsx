import { useState, type FormEvent, type ReactNode } from 'react';
import { Button, Field, Input, LogoMark, Notice } from '@open-signal/ui';
import { useI18n } from '../i18n.tsx';
import { useSession } from '../session.tsx';
import { api, errorText } from '../lib/api.ts';
import type { Me } from '../lib/types.ts';
import { FullScreenCenter, LangSelect } from '../components/layout.tsx';

function AuthCard({ title, text, children }: { title: string; text?: string; children: ReactNode }) {
  return (
    <FullScreenCenter>
      <div className="os-enter w-full max-w-[400px]">
        <div className="mb-10 flex items-center justify-between">
          <LogoMark size={40} />
          <LangSelect />
        </div>
        <h1 className="os-display text-[40px]">{title}</h1>
        {text ? <p className="mt-3 text-[15px] leading-relaxed text-muted">{text}</p> : null}
        <div className="mt-8">{children}</div>
      </div>
    </FullScreenCenter>
  );
}

export function SetupPage() {
  const { t } = useI18n();
  const { signedIn } = useSession();
  const [form, setForm] = useState({ setupToken: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ me: Me }>('POST', '/setup', form);
      signedIn(r.me);
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthCard title={t('admin.auth.setupTitle')} text={t('admin.auth.setupText')}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label={t('admin.auth.setupToken')} htmlFor="s-token">
          <Input id="s-token" type="password" autoComplete="off" value={form.setupToken} onChange={(e) => setForm({ ...form, setupToken: e.target.value })} />
        </Field>
        <Field label={t('admin.auth.email')} htmlFor="s-email">
          <Input id="s-email" type="email" autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label={t('admin.auth.password')} hint={t('admin.auth.passwordHint')} htmlFor="s-pw">
          <Input id="s-pw" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </Field>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Button type="submit" size="lg" busy={busy} disabled={!form.setupToken || !form.email || form.password.length < 10}>
          {t('admin.auth.createOwner')}
        </Button>
      </form>
    </AuthCard>
  );
}

export function LoginPage() {
  const { t } = useI18n();
  const { signedIn } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ me: Me }>('POST', '/login', { email, password });
      signedIn(r.me);
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthCard title={t('admin.auth.loginTitle')}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label={t('admin.auth.email')} htmlFor="l-email">
          <Input id="l-email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label={t('admin.auth.password')} htmlFor="l-pw">
          <Input id="l-pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Button type="submit" size="lg" busy={busy} disabled={!email || !password}>
          {t('admin.auth.signIn')}
        </Button>
      </form>
    </AuthCard>
  );
}

export function InvitePage({ token }: { token: string }) {
  const { t } = useI18n();
  const { signedIn } = useSession();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ me: Me }>('POST', '/invite/accept', { token, password });
      signedIn(r.me);
      window.location.hash = '/';
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthCard title={t('admin.auth.inviteTitle')} text={t('admin.auth.inviteText')}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label={t('admin.auth.password')} hint={t('admin.auth.passwordHint')} htmlFor="i-pw">
          <Input id="i-pw" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Button type="submit" size="lg" busy={busy} disabled={password.length < 10}>
          {t('admin.auth.acceptInvite')}
        </Button>
      </form>
    </AuthCard>
  );
}
