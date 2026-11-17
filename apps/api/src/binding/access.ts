import type { UserRecord } from '../domain/records.ts';

/**
 * The single server-side rule for "may this user use signals (and the rest of the app)":
 *  - onboarding completed normally (Trader ID linked + FTD confirmed by the partner), or
 *  - an admin granted manual access (audited, with a reason).
 * Manual access is a separate permission: revoking it never removes normal access.
 */
export function hasSignalAccess(user: Pick<UserRecord, 'onboardingCompletedAt' | 'manualAccess'>): boolean {
  return Boolean(user.onboardingCompletedAt) || user.manualAccess?.active === true;
}

export interface AccessView {
  signals: boolean;
  /** How access was obtained; normal onboarding wins when both apply. */
  via: 'onboarding' | 'manual' | null;
}

export function accessView(user: Pick<UserRecord, 'onboardingCompletedAt' | 'manualAccess'>): AccessView {
  return {
    signals: hasSignalAccess(user),
    via: user.onboardingCompletedAt ? 'onboarding' : user.manualAccess?.active ? 'manual' : null,
  };
}
