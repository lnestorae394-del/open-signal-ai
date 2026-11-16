import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

// ───────── Logo ─────────
/** Original Open Signal mark: a signal pulse inside rounded square. */
export function LogoMark({ size = 36, className }: { size?: number; className?: string }) {
  return (
    <span
      className={cx('inline-grid place-items-center rounded-[30%] os-btn-primary', className)}
      style={{ width: size, height: size }}
      aria-hidden
    >
      <svg width={size * 0.62} height={size * 0.62} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 13h4l2.5-6 4 12 3-8 1.5 2H22" />
      </svg>
    </span>
  );
}

export function Wordmark({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="flex items-center gap-3">
      <LogoMark />
      <div className="leading-tight">
        <div className="text-[15px] font-extrabold tracking-[0.14em] text-fg">{title}</div>
        {subtitle ? <div className="text-xs text-muted">{subtitle}</div> : null}
      </div>
    </div>
  );
}

// ───────── Button ─────────
type ButtonVariant = 'primary' | 'secondary' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'md' | 'lg' | 'sm';
  icon?: ReactNode;
  block?: boolean;
}

export function Button({ variant = 'primary', size = 'md', icon, block, className, children, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      className={cx(
        'inline-flex items-center justify-center gap-2 font-semibold transition-all duration-200 select-none',
        'active:scale-[0.98] disabled:cursor-not-allowed disabled:active:scale-100',
        size === 'lg' && 'h-14 rounded-2xl px-4 text-[15px]',
        size === 'md' && 'h-11 rounded-xl px-4 text-sm',
        size === 'sm' && 'h-8 rounded-lg px-3 text-xs',
        variant === 'primary' && 'os-btn-primary',
        variant === 'secondary' && 'border border-line-strong bg-white/[0.04] text-fg hover:bg-white/[0.07] disabled:opacity-50',
        variant === 'ghost' && 'text-muted hover:bg-white/[0.05] hover:text-fg disabled:opacity-50',
        block && 'w-full',
        className,
      )}
    >
      {icon}
      {children}
    </button>
  );
}

// ───────── Card ─────────
export function Card({ hero, className, children }: { hero?: boolean; className?: string; children: ReactNode }) {
  return <section className={cx(hero ? 'os-card os-card-hero' : 'os-card', 'p-4', className)}>{children}</section>;
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="text-[13px] font-semibold uppercase tracking-[0.12em] text-muted">{children}</h2>
      {action}
    </div>
  );
}

// ───────── Badges ─────────
type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

const toneClass: Record<Tone, string> = {
  neutral: 'bg-white/[0.06] text-muted border-line',
  primary: 'bg-primary/15 text-primary border-primary/30',
  success: 'bg-success/12 text-success border-success/30',
  warning: 'bg-warning/12 text-warning border-warning/30',
  danger: 'bg-danger/12 text-danger border-danger/30',
  info: 'bg-info/12 text-info border-info/30',
};

export function Badge({ tone = 'neutral', dot, children, className }: { tone?: Tone; dot?: boolean; children: ReactNode; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold tracking-wide', toneClass[tone], className)}>
      {dot ? <span className="h-1.5 w-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}

/** Data-quality marker. Every market value in the UI is shown next to one of these. */
export type DataStatusTone = 'LIVE' | 'DELAYED' | 'STALE' | 'MARKET_CLOSED' | 'UNAVAILABLE' | 'NO_VERIFIED_SOURCE';
const dataTone: Record<DataStatusTone, Tone> = {
  LIVE: 'success',
  DELAYED: 'warning',
  STALE: 'warning',
  MARKET_CLOSED: 'neutral',
  UNAVAILABLE: 'danger',
  NO_VERIFIED_SOURCE: 'danger',
};
export function DataStatusBadge({ status, label }: { status: DataStatusTone; label: string }) {
  return <Badge tone={dataTone[status]} dot>{label}</Badge>;
}

// ───────── Form controls ─────────
export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: string; error?: string | undefined; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-xs font-medium text-muted">{label}</label>
      {children}
      {error ? <p className="text-xs text-danger">{error}</p> : hint ? <p className="text-xs text-muted/80">{hint}</p> : null}
    </div>
  );
}

export function Input({ invalid, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <input
      {...rest}
      aria-invalid={invalid || undefined}
      className={cx(
        'h-11 w-full rounded-xl border bg-black/30 px-3.5 text-sm text-fg placeholder:text-muted/60 transition-colors outline-none',
        invalid ? 'border-danger/60' : 'border-line-strong focus:border-primary/70',
        className,
      )}
    />
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative h-6 w-11 shrink-0 rounded-full border p-0 transition-colors duration-200 disabled:opacity-40',
        checked ? 'border-primary/50 bg-primary' : 'border-line-strong bg-white/[0.08]',
      )}
    >
      <span className={cx('absolute left-0.5 top-0.5 h-[18px] w-[18px] rounded-full bg-white shadow transition-transform duration-200', checked ? 'translate-x-5' : 'translate-x-0')} />
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange, ariaLabel, block }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; ariaLabel: string; block?: boolean }) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cx('rounded-xl border border-line bg-white/[0.03] p-1', block ? 'grid' : 'inline-flex')}
      style={block ? { gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` } : undefined}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
          className={cx(
            'whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-semibold transition-all duration-200',
            o.value === value ? 'bg-primary/90 text-on-primary shadow-sm' : 'text-muted hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({ icon, title, text, children }: { icon?: ReactNode; title?: string; text: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
      {icon ? <div className="grid h-12 w-12 place-items-center rounded-2xl border border-line bg-white/[0.03] text-muted">{icon}</div> : null}
      {title ? <div className="text-sm font-semibold text-fg">{title}</div> : null}
      <p className="max-w-sm text-sm leading-relaxed text-muted">{text}</p>
      {children}
    </div>
  );
}

export function Notice({ tone = 'info', icon, children }: { tone?: Tone; icon?: ReactNode; children: ReactNode }) {
  return (
    <div className={cx('flex gap-2.5 rounded-xl border px-3.5 py-3 text-[13px] leading-relaxed', toneClass[tone])}>
      {icon ? <span className="mt-0.5 shrink-0">{icon}</span> : null}
      <div>{children}</div>
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <span className={cx('inline-block h-5 w-5 animate-spin rounded-full border-2 border-white/15 border-t-primary', className)} aria-hidden />;
}
