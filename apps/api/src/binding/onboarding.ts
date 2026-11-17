import { FTD_THRESHOLD_USD, type BotConfig, type DepositCheckStatus, type DepositStatus, type OnboardingStatus } from '@open-signal/shared';
import { sha256Hex } from '../lib/crypto.ts';
import { C } from '../storage/collections.ts';
import type { DocumentStore } from '../storage/types.ts';
import type { DepositSummary, UserRecord } from '../domain/records.ts';
import type { TenantScope } from '../domain/tenant.ts';
import { GLOBAL_SOURCE_BOT_ID, attributable, normalizeTraderId, summarizeDeposits, type PostbackEventRecord } from './service.ts';

/**
 * Mandatory three-step onboarding, derived ONLY from the server-side user record
 * and the stored postback events (never from the device): every launch of the
 * Mini App, on any phone, opens the screen that matches the stored state.
 */
export function onboardingStatus(user: UserRecord, check: DepositCheckStatus, requireFtd: boolean): OnboardingStatus {
  if (user.onboardingCompletedAt) return 'completed';
  switch (user.bindingState) {
    case 'account_bound':
      return !requireFtd || check === 'confirmed' ? 'completed' : 'deposit';
    case 'manual_review':
    case 'binding_conflict':
      return 'needs_support';
    default:
      // telegram_created, waiting_for_trader_id and the former pending states: the
      // Trader ID is not linked yet, so the user is on step 1 or 2.
      if (user.traderIdSubmitStartedAt) return 'trader_id';
      return user.registrationStartedAt ? 'registration_started' : 'registration';
  }
}

/** Step 3: is the first deposit confirmed by the partner postback? */
export function depositCheck(summary: DepositSummary | null): { status: DepositCheckStatus; reason: 'below_threshold' | 'amount_conflict' | 'no_amount' | 'currency' | 'no_ftd_event' | null } {
  if (!summary || summary.depositsCount === 0) return { status: 'awaiting', reason: null };
  if (summary.conflict) return { status: 'error', reason: 'amount_conflict' };
  // Only repeat-deposit events, no first-deposit (ftd) event: the FTD postback is missing → a person checks.
  if (!summary.ftdAt) return { status: 'checking', reason: 'no_ftd_event' };
  if (summary.ftdAmount === null) return { status: 'checking', reason: 'no_amount' };
  // Pocket Partners reports amounts in USD; an explicit other currency needs a person to check.
  if ((summary.ftdCurrency ?? 'USD') !== 'USD') return { status: 'checking', reason: 'currency' };
  if (summary.ftdAmount < FTD_THRESHOLD_USD) return { status: 'error', reason: 'below_threshold' };
  return { status: 'confirmed', reason: null };
}

export interface DepositView {
  status: DepositStatus;
  check: DepositCheckStatus;
  checkReason: ReturnType<typeof depositCheck>['reason'];
  /** True when an enabled postback source (global or this bot's) exists. */
  sourceConnected: boolean;
  thresholdUsd: number;
  ftdAmount: number | null;
  ftdCurrency: string | null;
  ftdAt: string | null;
  depositsCount: number;
  lastDepositAt: string | null;
}

export interface OnboardingView {
  status: OnboardingStatus;
  registrationStartedAt: string | null;
  traderIdMasked: string | null;
  verification: 'not_submitted' | 'failed' | 'confirmed' | 'review';
  lastError: string | null;
  deposit: DepositView;
  partner: { configured: boolean };
}

export class OnboardingService {
  private readonly store: DocumentStore;
  private readonly now: () => Date;

  constructor(deps: { store: DocumentStore; now: () => Date }) {
    this.store = deps.store;
    this.now = deps.now;
  }

  /** "I have registered": the user continues with the Trader ID (step 2). */
  async markReturned(scope: TenantScope, user: UserRecord): Promise<void> {
    if (!user.traderIdSubmitStartedAt) {
      await this.store.update(C.users, scope.userDocId(user.telegramId), { traderIdSubmitStartedAt: this.now().toISOString() });
    }
  }

  async view(scope: TenantScope, user: UserRecord, config: BotConfig, requireFtd: boolean): Promise<OnboardingView> {
    const deposit = await this.deposit(scope, user);
    const status = onboardingStatus(user, deposit.check, requireFtd);
    if (status === 'completed' && !user.onboardingCompletedAt) {
      await this.store.update(C.users, scope.userDocId(user.telegramId), { onboardingCompletedAt: this.now().toISOString() });
    }
    const bound = user.bindingState === 'account_bound';
    return {
      status,
      registrationStartedAt: user.registrationStartedAt ?? null,
      traderIdMasked: user.traderId ?? user.submittedTraderIdMasked ?? null,
      verification: bound ? 'confirmed' : status === 'needs_support' ? 'review' : user.lastBindingError ? 'failed' : 'not_submitted',
      lastError: bound ? null : (user.lastBindingError?.code ?? null),
      deposit,
      partner: { configured: config.partner.linkTemplate !== null },
    };
  }

  /**
   * Deposit data comes only from postback events of the user's own, verified
   * Trader ID — and only events attributable to this user (see `attributable`).
   */
  private async deposit(scope: TenantScope, user: UserRecord): Promise<DepositView> {
    const [botSources, globalSources] = await Promise.all([
      this.store.query(C.partnerSources, { where: scope.where({ field: 'enabled', op: '==', value: true }), limit: 1 }),
      this.store.query(C.partnerSources, { where: [{ field: 'botId', op: '==', value: GLOBAL_SOURCE_BOT_ID }, { field: 'enabled', op: '==', value: true }], limit: 1 }),
    ]);
    const sourceConnected = botSources.length > 0 || globalSources.length > 0;
    const uid = scope.userDocId(user.telegramId);
    let summary: DepositSummary | null = null;
    if (user.bindingState === 'account_bound' && user.traderId) {
      const hash = sha256Hex(normalizeTraderId(user.traderId));
      const events = await this.store.query<PostbackEventRecord>(C.postbackEvents, {
        where: scope.where({ field: 'traderIdHash', op: '==', value: hash }),
        limit: 500,
      });
      summary = summarizeDeposits(events.map((e) => e.data).filter((e) => scope.owns(e) && attributable(e, uid)), this.now().toISOString());
      const prev = user.deposit;
      if (!prev || prev.depositsCount !== summary.depositsCount || prev.status !== summary.status || Boolean(prev.conflict) !== Boolean(summary.conflict) || prev.totalAmount !== summary.totalAmount) {
        await this.store.update(C.users, uid, { deposit: summary });
      }
    }
    const check = depositCheck(summary);
    return {
      status: !summary ? 'unknown' : summary.status,
      check: check.status,
      checkReason: check.reason,
      sourceConnected,
      thresholdUsd: FTD_THRESHOLD_USD,
      ftdAmount: summary?.ftdAmount ?? null,
      ftdCurrency: summary?.ftdCurrency ?? null,
      ftdAt: summary?.ftdAt ?? null,
      depositsCount: summary?.depositsCount ?? 0,
      lastDepositAt: summary?.lastDepositAt ?? null,
    };
  }
}
