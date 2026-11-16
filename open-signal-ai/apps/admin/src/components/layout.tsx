import type { ReactNode } from 'react';

export type Route = 'dashboard' | 'bots' | 'bots/new' | 'academy' | 'users' | 'logs' | 'managers';
export const ROUTES: Route[] = ['dashboard', 'bots', 'bots/new', 'academy', 'users', 'logs', 'managers'];

export function readRoute(): Route {
  const r = window.location.hash.replace(/^#\/?/, '') as Route;
  return ROUTES.includes(r) ? r : 'dashboard';
}

export function navigate(r: Route) {
  window.location.hash = `/${r}`;
}

export function PageTitle({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight lg:text-[28px]">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-muted">{subtitle}</p> : null}
      </div>
      {action}
    </div>
  );
}
