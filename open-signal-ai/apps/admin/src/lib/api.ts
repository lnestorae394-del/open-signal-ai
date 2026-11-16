export const API_URL = (import.meta.env.VITE_API_URL ?? 'http://localhost:8080').replace(/\/$/, '');

export interface Health {
  status: string;
  time: string;
  storage: string;
  firebaseConnected: boolean;
  telegramConnected: boolean;
  marketDataConnected: boolean;
}

/** The only admin call available in Stage 1: real system status from the API. */
export async function fetchHealth(): Promise<Health | null> {
  try {
    const r = await fetch(`${API_URL}/health`);
    if (!r.ok) return null;
    return (await r.json()) as Health;
  } catch {
    return null;
  }
}
