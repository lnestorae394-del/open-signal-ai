import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from './lib/api.ts';
import type { Me } from './lib/types.ts';

type State =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'setup' }
  | { kind: 'signed-out' }
  | { kind: 'signed-in'; me: Me };

interface SessionCtx {
  state: State;
  refresh(): Promise<void>;
  signedIn(me: Me): void;
  logout(): Promise<void>;
}

const Ctx = createContext<SessionCtx | null>(null);

export function useSession(): SessionCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession outside provider');
  return v;
}

export function useMe(): Me {
  const { state } = useSession();
  if (state.kind !== 'signed-in') throw new Error('not signed in');
  return state.me;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ kind: 'loading' });

  const refresh = useCallback(async () => {
    try {
      const r = await api<{ me: Me }>('GET', '/me');
      setState({ kind: 'signed-in', me: r.me });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        try {
          const s = await api<{ needsSetup: boolean }>('GET', '/setup');
          setState({ kind: s.needsSetup ? 'setup' : 'signed-out' });
        } catch {
          setState({ kind: 'error' });
        }
      } else {
        setState({ kind: 'error' });
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value: SessionCtx = {
    state,
    refresh,
    signedIn: (me) => setState({ kind: 'signed-in', me }),
    logout: async () => {
      await api('POST', '/logout').catch(() => undefined);
      setState({ kind: 'signed-out' });
      window.location.hash = '/';
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
