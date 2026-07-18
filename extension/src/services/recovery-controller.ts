export type TicketFailureKind =
  | 'oracle_refusal'
  | 'worker_failure'
  | 'preflight'
  | 'verification_contract';

export type RecoveryAction = 'retry' | 'skip' | 'abort';

export interface TicketRecoveryInput {
  failureKind: TicketFailureKind;
  failureMode: string;
  attempt: number;
  maxAttempts: number;
  stopReason?: string | null;
  circuitOpen?: boolean;
  failureExitReason?: string;
}

export interface TicketRecoveryDecision {
  action: RecoveryAction;
  exitReason: string | null;
  reason: string;
}

/**
 * A deliberately small, bounded recovery ladder. Safety/contract failures are
 * terminal, an open circuit refuses more work, and retry-once can schedule at
 * most the caller-provided attempt bound. Budgets always win over retry.
 */
export function decideTicketRecovery(input: TicketRecoveryInput): TicketRecoveryDecision {
  const failureExitReason = input.failureExitReason || 'error';
  if (input.circuitOpen) {
    return { action: 'abort', exitReason: 'circuit_open', reason: 'circuit breaker is OPEN' };
  }
  if (input.failureKind === 'preflight' || input.failureKind === 'verification_contract') {
    return { action: 'abort', exitReason: failureExitReason, reason: `${input.failureKind} failures are not retryable` };
  }
  if (input.stopReason === 'max_time' || input.stopReason === 'max_iterations') {
    return { action: 'abort', exitReason: failureExitReason, reason: `${input.stopReason} prevents recovery` };
  }
  if (input.failureMode === 'retry-once' && input.attempt < input.maxAttempts) {
    return { action: 'retry', exitReason: null, reason: 'bounded retry available' };
  }
  if (input.failureMode === 'skip') {
    return { action: 'skip', exitReason: null, reason: 'configured to skip failed tickets' };
  }
  return { action: 'abort', exitReason: failureExitReason, reason: 'recovery attempts exhausted' };
}
