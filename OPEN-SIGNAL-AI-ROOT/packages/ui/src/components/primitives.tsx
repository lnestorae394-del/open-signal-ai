import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

// ───────── Brand ─────────
/** The Open Signal mark: a pulse line crossing a rounded square. */
export function LogoMark({ size = 36, className, src }: { size?: number; className?: string; src?: string | null }) {
  if (src) {
    return <img src={src} alt="" width={size} height={size} className={cx('shrink-0 rounded-[30%] object-cover', className)} />;
  }
  return (
    <span className={cx('inline-grid shrink-0 place-items-center rounded-[30%] os-btn-primary', className)} style={{ width: size, height: size }} aria-hidden>
      <svg width={size * 0.64} height={size * 0.64} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 13h4l2.5-6 4 12 3-8 1.5 2H22" />
      </svg>
    </span>
  );
}

// ───────── Button ─────────
type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  icon?: ReactNode;
  block?: boolean;
  busy?: boolean;
}

export function Button({ variant = 'primary', size = 'md', icon, block, busy, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(
        'relative inline-flex items-center justify-center gap-2 font-semibold whitespace-nowrap transition-[filter,background-color,color,transform] duration-200 select-none',
        'active:scale-[0.985] disabled:cursor-not-allowed disabled:active:scale-100',
        size === 'lg' && 'h-14 rounded-2xl px-5 text-[15px]',
        size === 'md' && 'h-11 rounded-xl px-4 text-sm',
        size === 'sm' && 'h-8 rounded-lg px-3 text-[13px]',
        variant === 'primary' && 'os-btn-primary',
        variant === 'secondary' && 'bg-white/[0.06] text-fg hover:bg-white/[0.1] disabled:text-muted',
        variant === 'ghost' && 'text-muted hover:bg-white/[0.05] hover:text-fg disabled:opacity-50',
        variant === 'danger' && 'bg-danger/12 text-danger hover:bg-danger/20 disabled:opacity-50',
        block && 'w-full',
        className,
      )}
    >
      {busy ? <Spinner className="h-4 w-4" /> : icon}
      {children}
    </button>
  );
}

// ───────── Surfaces ─────────
export function Panel({ className, children, as = 'section' }: { className?: string; children: ReactNode; as?: 'section' | 'div' | 'li' }) {
  const Tag = as;
  return <Tag className={cx('os-panel', className)}>{children}</Tag>;
}

/** @deprecated kept for compatibility — use Panel */
export const Card = ({ className, children }: { hero?: boolean; className?: string; children: ReactNode }) => <Panel className={cx('p-4', className)}>{children}</Panel>;

export function SectionTitle({ children, action, hint }: { children: ReactNode; action?: ReactNode; hint?: string }) {
  return (
    <div className="mb-3 flex items-end justify-between gap-3">
      <div>
        <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-fg">{children}</h2>
        {hint ? <p className="mt-0.5 text-[13px] text-muted">{hint}</p> : null}
      </div>
      {action}
    </div>
  );
}

// ───────── Badges ─────────
export type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

const toneClass: Record<Tone, string> = {
  neutral: 'bg-white/[0.07] text-muted',
  primary: 'bg-primary/15 text-primary',
  success: 'bg-success/12 text-success',
  warning: 'bg-warning/12 text-warning',
  danger: 'bg-danger/12 text-danger',
  info: 'bg-info/12 text-info',
};

export function Badge({ tone = 'neutral', dot, children, className }: { tone?: Tone; dot?: boolean; children: ReactNode; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-[3px] text-xs font-medium', toneClass[tone], className)}>
      {dot ? <span className="h-1.5 w-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}

export type DataStatusTone = 'LIVE' | 'DELAYED' | 'STALE' | 'MARKET_CLOSED' | 'UNAVAILABLE' | 'NO_VERIFIED_SOURCE' | 'SIMULATED';
const dataTone: Record<DataStatusTone, Tone> = {
  LIVE: 'success',
  DELAYED: 'warning',
  STALE: 'warning',
  MARKET_CLOSED: 'neutral',
  UNAVAILABLE: 'neutral',
  NO_VERIFIED_SOURCE: 'danger',
  SIMULATED: 'warning',
};
/** Data-quality marker. Every market value in the UI is shown next to one of these. */
export function DataStatusBadge({ status, label }: { status: DataStatusTone; label: string }) {
  return <Badge tone={dataTone[status]} dot>{label}</Badge>;
}

// ───────── Form controls ─────────
export function Field({ label, hint, error, children, htmlFor, aside }: { label: string; hint?: string; error?: string | undefined; children: ReactNode; htmlFor?: string; aside?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={htmlFor} className="text-[13px] font-medium text-fg/90">{label}</label>
        {aside}
      </div>
      {children}
      {error ? <p className="text-[13px] text-danger">{error}</p> : hint ? <p className="text-[13px] text-muted">{hint}</p> : null}
    </div>
  );
}

export function Input({ invalid, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <input
      {...rest}
      aria-invalid={invalid || undefined}
      className={cx(
        'h-11 w-full rounded-xl border bg-white/[0.03] px-3.5 text-[15px] text-fg placeholder:text-muted/60 outline-none transition-colors',
        invalid ? 'border-danger/70' : 'border-line-strong hover:border-white/25 focus:border-primary',
        className,
      )}
    />
  );
}

export function TextArea({ value, onChange, rows = 3, maxLength, id, placeholder }: { value: string; onChange: (v: string) => void; rows?: number; maxLength?: number; id?: string; placeholder?: string }) {
  return (
    <textarea
      id={id}
      value={value}
      rows={rows}
      maxLength={maxLength}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-xl border border-line-strong bg-white/[0.03] px-3.5 py-3 text-[15px] text-fg outline-none placeholder:text-muted/60 hover:border-white/25 focus:border-primary"
    />
  );
}

export function Select<T extends string>({ value, onChange, options, id, ariaLabel }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; id?: string; ariaLabel?: string }) {
  return (
    <select
      id={id}
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className="h-11 w-full rounded-xl border border-line-strong bg-surface px-3 text-[15px] text-fg outline-none hover:border-white/25 focus:border-primary"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
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
      className={cx('relative h-6 w-11 shrink-0 rounded-full p-0 transition-colors duration-200 disabled:opacity-40', checked ? 'bg-primary' : 'bg-white/[0.14]')}
    >
      <span className={cx('absolute left-[3px] top-[3px] h-[18px] w-[18px] rounded-full bg-white shadow transition-transform duration-200', checked ? 'translate-x-5' : 'translate-x-0')} />
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange, ariaLabel, block }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; ariaLabel: string; block?: boolean }) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cx('rounded-2xl bg-white/[0.05] p-1', block ? 'grid' : 'inline-flex')}
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
            'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-xl px-3.5 py-2 text-[13px] font-semibold transition-all duration-200',
            o.value === value ? 'bg-fg text-bg shadow-sm' : 'text-muted hover:text-fg',
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
      {icon ? <div className="grid h-12 w-12 place-items-center rounded-2xl bg-white/[0.05] text-muted">{icon}</div> : null}
      {title ? <div className="text-[15px] font-semibold text-fg">{title}</div> : null}
      <p className="max-w-sm text-[14px] leading-relaxed text-muted">{text}</p>
      {children}
    </div>
  );
}

export function Notice({ tone = 'info', icon, children, className }: { tone?: Tone; icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cx('flex gap-2.5 rounded-2xl px-4 py-3 text-[14px] leading-relaxed', toneClass[tone], className)}>
      {icon ? <span className="mt-0.5 shrink-0">{icon}</span> : null}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <span className={cx('inline-block h-5 w-5 animate-spin rounded-full border-2 border-white/15 border-t-primary', className)} aria-hidden />;
}

/** Bars of a daily series — values only from real data; a day without data is a gap, not a zero bar. */
export function BarChart({ points, height = 120, label }: { points: { label: string; value: number | null }[]; height?: number; label: string }) {
  const max = Math.max(1, ...points.map((p) => p.value ?? 0));
  return (
    <figure aria-label={label} className="m-0">
      <div className="flex items-end gap-1.5" style={{ height }}>
        {points.map((p) => (
          <div key={p.label} className="group flex h-full flex-1 flex-col justify-end" title={`${p.label}: ${p.value ?? '—'}`}>
            {p.value === null ? (
              <div className="h-[2px] rounded-full bg-white/[0.08]" />
            ) : (
              <div
                className="rounded-t-md bg-primary/80 transition-[height] duration-500 group-hover:bg-primary"
                style={{ height: `${Math.max(2, (p.value / max) * 100)}%` }}
              />
            )}
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-1.5 text-[11px] text-muted">
        {points.map((p, i) => (
          <span key={p.label} className="flex-1 truncate text-center">{i % Math.ceil(points.length / 7) === 0 ? p.label : ''}</span>
        ))}
      </div>
    </figure>
  );
}
