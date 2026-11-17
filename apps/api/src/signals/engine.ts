import { randomInt } from 'node:crypto';
import type { SignalCategory, SignalEngineKind } from '@open-signal/shared';

export interface SignalRequest {
  instrumentId: string;
  category: SignalCategory;
  periodSec: number;
}

export interface SignalDecision {
  direction: 'buy' | 'sell';
}

/**
 * Where a signal direction comes from. Today only the training engine exists.
 * A real engine (verified market data + a validated model) implements this
 * interface with kind "analysis"; the Mini App then shows the analysis wording.
 */
export interface SignalEngine {
  readonly kind: SignalEngineKind;
  decide(req: SignalRequest): Promise<SignalDecision>;
}

/**
 * Training signals: no market data, no model — the direction is chosen at random
 * with equal probability. The interface labels such a signal as a training signal
 * and never presents it as market analysis or promises a result.
 */
export class TrainingSignalEngine implements SignalEngine {
  readonly kind = 'training' as const;

  async decide(): Promise<SignalDecision> {
    return { direction: randomInt(2) === 0 ? 'buy' : 'sell' };
  }
}
