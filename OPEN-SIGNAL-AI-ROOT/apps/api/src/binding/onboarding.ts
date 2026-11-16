import { FTD_THRESHOLD_USD, type BotConfig, type DepositStatus, type OnboardingStatus } from '@open-signal/shared';
import { sha256Hex } from '../lib/crypto.ts';
import { C } from '../storage/collections.ts';
import type { DocumentStore } from '../storage/types.ts';
import type { DepositSummary, UserRecord } from '../domain/records.ts';
import type { TenantScope } from '../domain/tenant.ts';
import { normalizeTraderId, summarizeDeposits, type PostbackEventRecord } from './service.ts';

/**
 * Three-step onboarding, derived ONLY from the server-side user record
 * (never from the device): every launch of the Mini App, on any phone,
 * opens the screen that matches the stored state.
 */
export function onboardingStatus(user: UserRecord, config: Pick<BotConfig, 'modules'>): OnboardingStatus {
  if (config.modules.account_binding !== true) return 'completed';
  switch (user.bindingState) {
    case 'account_bound':
    case 'registration_verified':
      return 'completed';
    case 'manual_review':
    case 'binding_conflict':
      return 'needs_support';
    case 'registration_pending':
      return 'pending_review';
    default:
      if (user.traderIdSubmitStartedAt) return 'trader_id';
      return user.registrationStartedAt ? 'registration_started' : 'registration';
  }
}

export interface DepositView {
  status: DepositStatus;
  /** True when at least one enabled postback source exists for the bot. */
  sourceConnected: boolean;
  ftdAmount: number | null;
  ftdCurrency: string | null;
  ftdAt: string | null;
  /** FTD of at least FTD_THRESHOLD_USD confirmed by the source. */
  ftdThresholdMet: boolean;
  depositsCount: number;
  lastDepositAt: string | null;
}

export interface OnboardingView {
  status: OnboardingStatus;
  registrationStartedAt: string | null;
  traderIdMasked: string | null;
  verification: 'not_submitted' | 'pending' | 'confirmed' | 'review';
  deposit: DepositView;
  partner: { configured: boolean };
}

const verifiedHash = (u: UserRecord): string | null =>
  u.bindingState === 'account_bound' && u.traderId ? sha256Hex(normalizeTraderId(u.traderId)) : u.bindingState === 'registration_verified' ? u.verifiedTraderIdHash : null;

export class OnboardingService {
  private readonly store: DocumentStore;
  private readonly now: () => Date;

  constructor(deps: { store: DocumentStore; now: () => Date }) {
    this.store = deps.store;
    this.now = deps.now;
  }

  /** Remembers that the user came back from the partner site and is now entering the Trader ID. */
  async markReturned(scope: TenantScope, user: UserRecord): Promise<void> {
    if (!user.traderIdSubmitStartedAt) {
      await this.store.update(C.users, scope.userDocId(user.telegramId), { traderIdSubmitStartedAt: this.now().toISOString() });
    }
  }

  async view(scope: TenantScope, user: UserRecord, config: BotConfig, maskedTraderId: string | null): Promise<OnboardingView> {
    const status = onboardingStatus(user, config);
    const verification: OnboardingView['verification'] =
      status === 'completed' && config.modules.account_binding === true
        ? 'confirmed'
        : user.bindingState === 'registration_pending'
          ? 'pending'
          : status === 'needs_support'
            ? 'review'
            : 'not_submitted';
    return {
      status,
      registrationStartedAt: user.registrationStartedAt ?? null,
      traderIdMasked: maskedTraderId,
      verification,
      deposit: await this.deposit(scope, user),
      partner: { configured: config.partner.linkTemplate !== null },
    };
  }

  /**
   * Deposit status is known only for a verified Trader ID and only from postback
   * events. Without a connected source it stays "unknown" — never a made-up value.
   */
  private async deposit(scope: TenantScope, user: UserRecord): Promise<DepositView> {
    const sources = await this.store.query(C.partnerSources, { where: scope.where({ field: 'enabled', op: '==', value: true }), limit: 1 });
    const sourceConnected = sources.length > 0;
    const hash = verifiedHash(user);
    let summary: DepositSummary | null = null;
    if (hash && sourceConnected) {
      const events = await this.store.query<PostbackEventRecord>(C.postbackEvents, {
        where: scope.where({ field: 'traderIdHash', op: '==', value: hash }),
        limit: 500,
      });
      summary = summarizeDeposits(events.map((e) => e.data).filter((e) => scope.owns(e)), this.now().toISOString());
      const prev = user.deposit;
      if (!prev || prev.depositsCount !== summary.depositsCount || prev.status !== summary.status) {
        await this.store.update(C.users, scope.userDocId(user.telegramId), { deposit: summary });
      }
    }
    const status: DepositStatus = !summary ? 'unknown' : summary.status;
    return {
      status,
      sourceConnected,
      ftdAmount: summary?.ftdAmount ?? null,
      ftdCurrency: summary?.ftdCurrency ?? null,
      ftdAt: summary?.ftdAt ?? null,
      ftdThresholdMet: !!summary && summary.ftdAmount !== null && summary.ftdAmount >= FTD_THRESHOLD_USD && (summary.ftdCurrency ?? 'USD') === 'USD',
      depositsCount: summary?.depositsCount ?? 0,
      lastDepositAt: summary?.lastDepositAt ?? null,
    };
  }
}
