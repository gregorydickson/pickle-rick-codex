import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { validateAutonomousOwnerSpec, type AutonomousSupervisorReadyReceipt } from './autonomous-owner-recovery.js';
import { isPersistedProcessIdentityValid, type PersistedProcessIdentity } from './orphan-reaper.js';

function validReadyReceipt(value: unknown): value is AutonomousSupervisorReadyReceipt {
  const receipt = value as AutonomousSupervisorReadyReceipt | null;
  if (!receipt || receipt.schema_version !== 1 || !/^[a-f0-9]{64}$/.test(String(receipt.receipt_id || ''))
    || !isPersistedProcessIdentityValid(receipt.supervisor_identity)
    || (receipt.recovery_daemon_identity !== null
      && !isPersistedProcessIdentityValid(receipt.recovery_daemon_identity))
    || typeof receipt.owner_spec_id !== 'string' || typeof receipt.node_path !== 'string'
    || typeof receipt.supervisor_path !== 'string' || typeof receipt.working_dir !== 'string'
    || typeof receipt.session_dir !== 'string' || typeof receipt.runner_bin !== 'string'
    || !Array.isArray(receipt.runner_args) || !receipt.runner_args.every((entry) => typeof entry === 'string')
    || (receipt.adoption_challenge !== null && typeof receipt.adoption_challenge !== 'string')
    || !Number.isFinite(Date.parse(receipt.ready_at))) return false;
  const unsigned = { ...receipt } as Omit<AutonomousSupervisorReadyReceipt, 'receipt_id'> & { receipt_id?: string };
  delete unsigned.receipt_id;
  return crypto.createHash('sha256').update(JSON.stringify(unsigned)).digest('hex') === receipt.receipt_id;
}

function sameIdentity(left: PersistedProcessIdentity, right: PersistedProcessIdentity): boolean {
  return left.pid === right.pid && left.pgid === right.pgid && left.start_time === right.start_time
    && left.fingerprint === right.fingerprint && left.identity_version === right.identity_version
    && left.session_id === right.session_id && left.command_sha256 === right.command_sha256
    && left.identity_kind === right.identity_kind && left.strict_command === right.strict_command;
}

export function validCommittedLegacyAdoptionTransfer(
  sessionDir: string,
  transaction: unknown,
  state: Record<string, unknown> | null,
): boolean {
  const txn = transaction as Record<string, unknown> | null;
  const handoff = txn?.post_handoff_recovery as Record<string, unknown> | null;
  const owner = handoff?.owner_identity as PersistedProcessIdentity | null;
  const daemon = handoff?.recovery_daemon_identity as PersistedProcessIdentity | null;
  const spec = validateAutonomousOwnerSpec(handoff?.owner_spec);
  const receipt = handoff?.ready_receipt;
  let canonicalSession: string;
  try { canonicalSession = fs.realpathSync(sessionDir); } catch { return false; }
  return Boolean(txn?.schema_version === 1 && txn.session_id === path.basename(canonicalSession)
    && txn.stage === 'quiesced' && state?.legacy_adoption_supervisor_challenge == null
    && handoff?.status === 'ownership_transferred' && isPersistedProcessIdentityValid(owner)
    && owner.pid === owner.pgid && isPersistedProcessIdentityValid(daemon)
    && typeof handoff.challenge === 'string' && handoff.challenge
    && Array.isArray(handoff.evidence) && handoff.evidence.every((entry) => typeof entry === 'string')
    && Number.isFinite(Date.parse(String(handoff.updated_at || ''))) && spec && validReadyReceipt(receipt)
    && spec.session_dir === canonicalSession && handoff.owner_spec_id === spec.spec_id
    && handoff.ready_receipt_id === receipt.receipt_id && receipt.owner_spec_id === spec.spec_id
    && sameIdentity(receipt.supervisor_identity, owner)
    && receipt.recovery_daemon_identity !== null
    && sameIdentity(receipt.recovery_daemon_identity, daemon)
    && receipt.adoption_challenge === handoff.challenge && receipt.session_dir === spec.session_dir
    && receipt.node_path === spec.node_path && receipt.supervisor_path === spec.supervisor_path
    && receipt.working_dir === spec.working_dir && receipt.runner_bin === spec.runner_bin
    && JSON.stringify(receipt.runner_args) === JSON.stringify(spec.runner_args));
}
