import type { BotConfig, BotStatus, ManagerPermission, Theme } from '@open-signal/shared';

export interface Me {
  uid: string;
  email: string;
  role: 'owner' | 'manager';
  botPermissions: Record<string, ManagerPermission[]>;
}

export interface TelegramSync {
  username: string | null;
  webhookUrl: string | null;
  syncedAt: string | null;
  issues: string[];
}

export interface BotSummary {
  botId: string;
  status: BotStatus;
  name: string;
  username: string;
  miniAppTitle: string;
  defaultLanguage: string;
  theme: Theme;
  tokenMasked: string | null;
  usersCount: number;
  telegram: TelegramSync | null;
  miniAppUrl: string;
  createdAt: string;
  logoUrl: string | null;
}

export interface BotDetail extends BotSummary {
  config: BotConfig & { botId: string; updatedAt: string };
}

export interface DailyPoint {
  day: string;
  metrics: Record<string, number>;
}

export interface Overview {
  bots: { total: number; active: number; disabled: number };
  users: number;
  days: DailyPoint[];
  errorGroups: number;
  recentEvents: { id: string; action: string; botId: string | null; at: string }[];
  telegramIssues: { botId: string; issues: string[] }[];
  storage: {
    driver: string;
    indexes: { state?: string; total?: number; ready?: number; building?: number; error?: string | null };
  };
}
