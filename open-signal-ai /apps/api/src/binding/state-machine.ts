import type { BindingState } from '@open-signal/shared';

/**
 * Allowed automatic (system) transitions. Anything else is a programming error
 * and throws. Admin actions are separate (see ADMIN_TARGETS) and always audited.
 */
const SYSTEM: Record<BindingState, readonly BindingState[]> = {
  telegram_created: ['waiting_for_trader_id', 'registration_verified'],
  waiting_for_trader_id: ['registration_pending', 'registration_verified', 'account_bound', 'binding_conflict', 'manual_review'],
  registration_pending: ['registration_pending', 'registration_verified', 'account_bound', 'binding_conflict', 'manual_review'],
  registration_verified: ['registration_verified', 'account_bound', 'binding_conflict', 'manual_review'],
  binding_conflict: ['registration_pending', 'registration_verified', 'account_bound', 'binding_conflict', 'manual_review'],
  manual_review: ['manual_review'],
  account_bound: ['account_bound'],
};

/** States an administrator may move a user to (from any state). */
export const ADMIN_TARGETS: readonly BindingState[] = ['account_bound', 'waiting_for_trader_id'];

export function canTransition(from: BindingState, to: BindingState, actor: 'system' | 'admin' = 'system'): boolean {
  if (actor === 'admin') return ADMIN_TARGETS.includes(to);
  return SYSTEM[from].includes(to);
}

export function assertTransition(from: BindingState, to: BindingState, actor: 'system' | 'admin' = 'system'): void {
  if (!canTransition(from, to, actor)) {
    throw new Error(`Illegal binding transition ${from} → ${to} by ${actor}`);
  }
}
