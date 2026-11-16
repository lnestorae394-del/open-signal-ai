/** Firestore collection names (single source of truth, see docs/firestore-schema.md). */
export const C = {
  bots: 'bots',
  botConfigs: 'bot_configs',
  users: 'users',
  userSettings: 'user_settings',
  /** Signals issued to users (shared signal system for all bots). */
  signals: 'signals',
  /** Platform-wide settings documents (e.g. "signals"). */
  platformSettings: 'platform_settings',
  /** Shared Academy: categories, lessons and per-user progress. */
  academyCategories: 'academy_categories',
  academyLessons: 'academy_lessons',
  academyProgress: 'academy_progress',
  adminUsers: 'admin_users',
  adminSessions: 'admin_sessions',
  adminInvites: 'admin_invites',
  adminEmails: 'admin_emails',
  adminMeta: 'admin_meta',
  botTokens: 'bot_tokens',
  auditLogs: 'audit_logs',
  errorLogs: 'error_logs',
  botEvents: 'bot_events',
  botStatsDaily: 'bot_stats_daily',
  media: 'media',
  webhookUpdates: 'webhook_updates',
  locks: 'locks',
  partnerSources: 'partner_sources',
  clickTokens: 'click_tokens',
  postbackEvents: 'postback_events',
  bindingClaims: 'binding_claims',
  traderBindings: 'trader_bindings',
  affiliateStatsDaily: 'affiliate_stats_daily',
} as const;

export type CollectionName = (typeof C)[keyof typeof C];
