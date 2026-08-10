#!/usr/bin/env node
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  captureProcessLivenessIdentity,
  inspectProcessLivenessIdentity,
  type PersistedProcessIdentity,
} from '../services/orphan-reaper.js';
import {
  BROKER_SHUTDOWN_RELEASE_TIMEOUT_MS,
  MIN_TARGET_STOP_ATTESTATION_OBSERVATIONS,
  TARGET_STOP_ATTESTATION_WINDOW_MS,
  TARGET_STOP_PROBE_TIMEOUT_MS,
} from '../services/monitored-process-protocol.js';

interface LaunchRequest {
  type: 'launch';
  launch_id: string;
  command_digest: string;
  command: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
}

const commandDigest = (request: Pick<LaunchRequest, 'command' | 'args' | 'cwd'>): string => crypto
  .createHash('sha256')
  .update(JSON.stringify({ command: request.command, args: request.args, cwd: request.cwd || null }))
  .digest('hex');

let launch: LaunchRequest | null = null;
let target: ChildProcess | null = null;
let brokerIdentity: PersistedProcessIdentity | null = null;
let targetIdentity: PersistedProcessIdentity | null = null;
let shuttingDown = false;
let shutdownCause = '';
let targetExitCode: number | null = null;
let targetSignal: NodeJS.Signals | null = null;
let targetReleased = false;
const descendantIdentities = new Map<number, PersistedProcessIdentity>();
const descendantCandidates = new Map<number, { identity: PersistedProcessIdentity; observations: number }>();
let descendantTracker: NodeJS.Timeout | null = null;
let shutdownGraceMs = 500;
let shutdownExecuting = false;
let terminationSignaled = false;
let shutdownTreeFrozen = false;
let shutdownReleaseTimer: NodeJS.Timeout | null = null;
let shutdownProgressSequence = 0;
let descendantDiscoveryAttempts = 0;

const registrationDeadline = setTimeout(() => fail('Monitored process broker registration timed out.'), 30_000);

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function send(message: Record<string, unknown>, callback?: (error: Error | null) => void): void {
  if (!process.connected) {
    callback?.(new Error('Monitored process broker IPC channel is disconnected.'));
    return;
  }
  try {
    process.send?.(message, (error) => callback?.(error || null));
  } catch (error) {
    callback?.(error instanceof Error ? error : new Error(String(error)));
  }
}

function sameIdentity(left: PersistedProcessIdentity, right: PersistedProcessIdentity): boolean {
  return left.pid === right.pid && left.pgid === right.pgid
    && left.start_time === right.start_time && left.fingerprint === right.fingerprint;
}

function publishDescendants(): void {
  if (!launch || !brokerIdentity || !targetIdentity || shuttingDown) return;
  send({
    type: 'descendants',
    launch_id: launch.launch_id,
    command_digest: launch.command_digest,
    broker_identity: brokerIdentity,
    target_identity: targetIdentity,
    descendant_identities: [...descendantIdentities.values()],
  });
}

type DescendantDiscoveryResult =
  | { status: 'snapshot'; snapshot: PersistedProcessIdentity[] }
  | { status: 'transient'; reason: string }
  | { status: 'integrity'; reason: string };

function discoverDescendants(): DescendantDiscoveryResult {
  if (process.platform === 'win32' || !targetIdentity) return { status: 'snapshot', snapshot: [] };
  descendantDiscoveryAttempts += 1;
  const injectedFailures = launch?.env.PICKLE_TEST_MODE === '1'
    ? Math.max(0, Number(launch.env.PICKLE_TEST_DESCENDANT_DISCOVERY_FAILURES || 0)) : 0;
  if (descendantDiscoveryAttempts <= injectedFailures) {
    const delayMs = Math.max(0, Math.min(
      Number(launch?.env.PICKLE_TEST_DESCENDANT_DISCOVERY_FAILURE_DELAY_MS || 0), 2_000,
    ));
    if (delayMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    return { status: 'transient', reason: 'injected-discovery-failure' };
  }
  const result = spawnSync('ps', ['-axo', 'pid=', '-o', 'ppid='], { encoding: 'utf8', timeout: 2_000 });
  if (result.status !== 0) return { status: 'transient', reason: 'process-tree-probe-failed' };
  const children = new Map<number, number[]>();
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    children.set(parentPid, [...(children.get(parentPid) || []), pid]);
  }
  const pending = [...(children.get(targetIdentity.pid) || [])];
  const seen = new Set<number>();
  const snapshot: PersistedProcessIdentity[] = [];
  while (pending.length > 0) {
    const pid = pending.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    pending.push(...(children.get(pid) || []));
    const identity = captureProcessLivenessIdentity(pid, { identityKind: 'descendant' });
    if (!identity) return { status: 'transient', reason: 'descendant-identity-capture-failed' };
    snapshot.push(identity);
    const promoted = descendantIdentities.get(identity.pid);
    if (promoted) {
      if (!sameIdentity(promoted, identity)) {
        return { status: 'integrity', reason: 'promoted-descendant-identity-conflict' };
      }
      continue;
    }
    const prior = descendantCandidates.get(identity.pid);
    if (prior && launch?.env.PICKLE_TEST_MODE === '1'
      && launch.env.PICKLE_TEST_DESCENDANT_IDENTITY_CONFLICT === '1') {
      return { status: 'integrity', reason: 'injected-candidate-identity-conflict' };
    }
    if (prior && !sameIdentity(prior.identity, identity)) {
      return { status: 'integrity', reason: 'candidate-descendant-identity-conflict' };
    }
    if (!prior) {
      descendantCandidates.set(identity.pid, { identity, observations: 1 });
      continue;
    }
    prior.observations += 1;
    if (prior.observations >= 2) {
      descendantIdentities.set(identity.pid, identity);
      descendantCandidates.delete(identity.pid);
      publishDescendants();
    }
  }
  return { status: 'snapshot', snapshot: snapshot.sort((left, right) => left.pid - right.pid) };
}

async function convergeDescendantsForShutdown(): Promise<boolean> {
  if (process.platform === 'win32' || !targetIdentity) return true;
  const publishProgress = (
    stage: string,
    observationCount: number,
    snapshot: PersistedProcessIdentity[] | null,
  ): void => {
    if (!launch || !brokerIdentity || !targetIdentity) return;
    shutdownProgressSequence += 1;
    send({
      type: 'shutdown_progress',
      launch_id: launch.launch_id,
      command_digest: launch.command_digest,
      broker_identity: brokerIdentity,
      target_identity: targetIdentity,
      cause: shutdownCause,
      sequence: shutdownProgressSequence,
      stage,
      observation_count: observationCount,
      epoch,
      snapshot_digest: snapshot === null ? null : crypto.createHash('sha256')
        .update(JSON.stringify(snapshot)).digest('hex'),
    });
    if (stage === 'shutdown-started' && launch.env.PICKLE_TEST_MODE === '1'
      && launch.env.PICKLE_TEST_OSCILLATING_SHUTDOWN_PROGRESS === '1') {
      for (const [index, digest] of ['a'.repeat(64), 'b'.repeat(64), 'a'.repeat(64)].entries()) {
        shutdownProgressSequence += 1;
        send({
          type: 'shutdown_progress',
          launch_id: launch.launch_id,
          command_digest: launch.command_digest,
          broker_identity: brokerIdentity,
          target_identity: targetIdentity,
          cause: shutdownCause,
          sequence: shutdownProgressSequence,
          stage: 'snapshot-observed',
          observation_count: index + 1,
          epoch: 0,
          snapshot_digest: digest,
        });
      }
    }
    if (launch.env.PICKLE_TEST_MODE === '1'
      && launch.env.PICKLE_TEST_FORGED_SHUTDOWN_PROGRESS === '1') {
      send({
        type: 'shutdown_progress',
        launch_id: crypto.randomUUID(),
        command_digest: launch.command_digest,
        broker_identity: brokerIdentity,
        target_identity: targetIdentity,
        cause: shutdownCause,
        sequence: shutdownProgressSequence,
        stage,
        observation_count: observationCount,
        snapshot_digest: null,
      });
    }
  };
  const epochWindowMs = launch?.env.PICKLE_TEST_MODE === '1'
    ? Math.max(100, Math.min(
      Number(launch.env.PICKLE_TEST_CONVERGENCE_EPOCH_MS || TARGET_STOP_ATTESTATION_WINDOW_MS),
      TARGET_STOP_ATTESTATION_WINDOW_MS,
    )) : TARGET_STOP_ATTESTATION_WINDOW_MS;
  let epochDeadline = Date.now() + epochWindowMs;
  let epoch = 0;
  let previousSnapshot: PersistedProcessIdentity[] | null = null;
  let attempts = 0;
  let totalObservations = 0;
  publishProgress('shutdown-started', 0, null);
  while (shuttingDown) {
    if (!process.connected) {
      executeShutdown();
      return false;
    }
    attempts += 1;
    totalObservations += 1;
    const discovery = discoverDescendants();
    if (discovery.status === 'integrity') return false;
    if (discovery.status === 'snapshot') {
      const { snapshot } = discovery;
      if (attempts === 1 && launch?.env.PICKLE_TEST_MODE === '1'
        && launch.env.PICKLE_TEST_REPARENT_CANDIDATE_AFTER_FIRST_SNAPSHOT === '1'
        && snapshot.length > 0) {
        try { process.kill(snapshot[0].pid, 'SIGKILL'); } catch { /* deterministic test race */ }
      }
      const testDelayMs = launch?.env.PICKLE_TEST_MODE === '1'
        ? Math.max(0, Math.min(
          Number(launch.env.PICKLE_TEST_DESCENDANT_CONVERGENCE_DELAY_MS || 0), 30_000,
        )) : 0;
      if (testDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, testDelayMs));
      if (!process.connected) {
        executeShutdown();
        return false;
      }
      let snapshotTrusted = true;
      let identityConflict = false;
      for (const identity of [targetIdentity, ...snapshot]) {
        const liveness = inspectProcessLivenessIdentity(identity);
        if (liveness === 'reused') {
          snapshotTrusted = false;
          identityConflict = true;
          continue;
        }
        if (liveness !== 'matched') continue;
        try {
          if (launch?.env.PICKLE_TEST_MODE === '1'
            && launch.env.PICKLE_TEST_SIGSTOP_EPERM === '1') {
            throw Object.assign(new Error('injected SIGSTOP authority loss'), { code: 'EPERM' });
          }
          process.kill(identity.pid, 'SIGSTOP');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
            snapshotTrusted = false;
            identityConflict = true;
          }
        }
      }
      shutdownTreeFrozen = true;
      const snapshotPids = new Set(snapshot.map(({ pid }) => pid));
      for (const [pid, candidate] of descendantCandidates) {
        if (snapshotPids.has(pid)) continue;
        const liveness = inspectProcessLivenessIdentity(candidate.identity);
        if (liveness === 'reused') {
          snapshotTrusted = false;
          identityConflict = true;
          continue;
        }
        if (liveness === 'not-running') {
          descendantCandidates.delete(pid);
          continue;
        }
        // The immutable candidate identity was captured once at birth and has
        // now been independently revalidated after leaving the target's PPID
        // tree. It remains owned and must be sealed into the shutdown ledger.
        descendantIdentities.set(pid, candidate.identity);
        descendantCandidates.delete(pid);
      }
      if (identityConflict) return false;
      const stable = snapshotTrusted && previousSnapshot !== null
        && previousSnapshot.length === snapshot.length
        && snapshot.every((identity, index) => sameIdentity(previousSnapshot![index], identity));
      const fullyPromoted = descendantCandidates.size === 0 && snapshot.every((identity) => {
        const promoted = descendantIdentities.get(identity.pid);
        return Boolean(promoted && sameIdentity(promoted, identity));
      });
      publishProgress('snapshot-observed', totalObservations, snapshot);
      if (stable && fullyPromoted) return true;
      previousSnapshot = snapshotTrusted ? snapshot : null;
    } else {
      previousSnapshot = null;
    }
    if (launch?.env.PICKLE_TEST_MODE === '1'
      && launch.env.PICKLE_TEST_DESCENDANT_CONVERGENCE_FORCE_FAILURE === '1') return false;
    if (attempts >= MIN_TARGET_STOP_ATTESTATION_OBSERVATIONS && Date.now() >= epochDeadline) {
      epoch += 1;
      attempts = 0;
      previousSnapshot = null;
      const backoffMs = Math.min(25 * (2 ** Math.min(epoch, 5)), 500);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      if (!process.connected) {
        executeShutdown();
        return false;
      }
      epochDeadline = Date.now() + epochWindowMs;
    }
  }
  return false;
}

let targetStopProbeAttempts = 0;

function targetIsStopped(pid: number): boolean {
  if (process.platform === 'win32') return true;
  targetStopProbeAttempts += 1;
  const injectedFailures = launch?.env.PICKLE_TEST_MODE === '1'
    ? Math.max(0, Number(launch.env.PICKLE_TEST_TARGET_STOP_PROBE_FAILURES || 0)) : 0;
  if (targetStopProbeAttempts <= injectedFailures) {
    const delayMs = Math.max(0, Math.min(
      Number(launch?.env.PICKLE_TEST_TARGET_STOP_PROBE_DELAY_MS || 0),
      TARGET_STOP_PROBE_TIMEOUT_MS,
    ));
    if (delayMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    return false;
  }
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'state='], {
    encoding: 'utf8',
    timeout: TARGET_STOP_PROBE_TIMEOUT_MS,
  });
  return result.status === 0 && result.stdout.trim().startsWith('T');
}

async function waitForTargetStop(pid: number): Promise<boolean> {
  const deadline = Date.now() + TARGET_STOP_ATTESTATION_WINDOW_MS;
  let observations = 0;
  do {
    observations += 1;
    if (targetIsStopped(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  } while (observations < MIN_TARGET_STOP_ATTESTATION_OBSERVATIONS || Date.now() < deadline);
  return false;
}

function liveAttestedGroups(): Set<number> {
  const identities = [targetIdentity, ...descendantIdentities.values(),
    ...[...descendantCandidates.values()].map(({ identity }) => identity)].filter(
    (identity): identity is PersistedProcessIdentity => Boolean(identity),
  );
  const groups = new Set<number>();
  for (const identity of identities) {
    if (inspectProcessLivenessIdentity(identity) === 'matched') {
      groups.add(identity.pgid);
    }
  }
  return groups;
}

function signalOwnedGroups(signal: NodeJS.Signals): void {
  if (process.platform === 'win32') {
    try { target?.kill(signal); } catch { /* best effort on Windows */ }
    for (const identity of [...descendantIdentities.values(),
      ...[...descendantCandidates.values()].map(({ identity }) => identity)]) {
      if (inspectProcessLivenessIdentity(identity) !== 'matched') continue;
      try { process.kill(identity.pid, signal); } catch { /* exact child exited */ }
    }
    if (signal === 'SIGKILL') process.exit(1);
    return;
  }
  for (const pgid of liveAttestedGroups()) {
    if (pgid === process.pid) continue;
    try { process.kill(-pgid, signal); } catch { /* exact group raced with shutdown */ }
  }
  // This broker is the process-group leader and remains alive through TERM.
  // KILL is deliberately unconditional: descendants that ignore TERM or close
  // inherited stdio must not escape merely because the direct target exited.
  try {
    process.kill(-process.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      process.stderr.write(`Broker could not send ${signal} to its process group: ${String(error)}\n`);
    }
    if (signal === 'SIGKILL') process.exit(1);
  }
}

function signalTermination(): void {
  if (terminationSignaled) return;
  terminationSignaled = true;
  if (descendantTracker) clearInterval(descendantTracker);
  discoverDescendants();
  signalOwnedGroups('SIGTERM');
  // TERM remains pending for the processes frozen by the shutdown fixed-point
  // fence. CONT lets them consume TERM without reopening an admission window.
  if (shutdownTreeFrozen) signalOwnedGroups('SIGCONT');
}

function executeShutdown(): void {
  if (shutdownExecuting) return;
  shutdownExecuting = true;
  if (shutdownReleaseTimer) clearTimeout(shutdownReleaseTimer);
  shutdownReleaseTimer = null;
  signalTermination();
  const killTimer = setTimeout(() => signalOwnedGroups('SIGKILL'), shutdownGraceMs);
  killTimer.ref?.();
}

function beginShutdown(cause: string, graceMs: number): void {
  if (!launch || shuttingDown) return;
  const activeLaunch = launch;
  shuttingDown = true;
  shutdownCause = cause;
  clearTimeout(registrationDeadline);
  shutdownGraceMs = Math.max(0, Math.min(Number.isFinite(graceMs) ? graceMs : 500, 5_000));
  void convergeDescendantsForShutdown().then((converged) => {
    if (shutdownExecuting) return;
    if (!converged) {
      shutdownCause = `${shutdownCause}-descendant-convergence-failed`;
      executeShutdown();
      return;
    }
  const acknowledgement = {
    type: 'shutdown_ack',
    launch_id: activeLaunch.launch_id,
    command_digest: activeLaunch.command_digest,
    broker_identity: brokerIdentity,
    target_identity: targetIdentity,
    cause: shutdownCause,
    target_exit_code: targetExitCode,
    target_signal: targetSignal,
    descendant_identities: [...descendantIdentities.values()],
  };
  // Accepted IPC bytes do not prove that the controller consumed and durably
  // persisted this ledger. Stay alive until its identity-bound
  // `shutdown_release` proves receipt. The target tree receives TERM once the
  // ack is flushed so it cannot keep working while a healthy controller is
  // scheduler-starved, but the broker remains alive as the durable ledger.
  // Disconnect drains immediately; a connected-but-wedged controller gets the
  // bounded autonomous fallback below.
  const publishAcknowledgement = (): void => {
    send(acknowledgement, (error) => {
      if (error) {
        executeShutdown();
        return;
      }
      if (activeLaunch.env.PICKLE_TEST_MODE === '1'
        && activeLaunch.env.PICKLE_TEST_BROKER_CONFLICTING_SHUTDOWN_ACK === '1') {
        send({ ...acknowledgement, cause: 'success' });
      }
      if (shutdownExecuting) return;
      signalTermination();
      const testWedgeAfterAckMs = activeLaunch.env.PICKLE_TEST_MODE === '1'
        ? Math.max(0, Math.min(Number(activeLaunch.env.PICKLE_TEST_BROKER_WEDGE_AFTER_ACK_MS || 0), 10_000))
        : 0;
      if (testWedgeAfterAckMs > 0) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, testWedgeAfterAckMs);
      }
      shutdownReleaseTimer = setTimeout(() => {
        shutdownCause = `${shutdownCause}-controller-release-timeout`;
        process.stderr.write(`Monitored process broker autonomous fallback: ${shutdownCause}\n`);
        executeShutdown();
      }, BROKER_SHUTDOWN_RELEASE_TIMEOUT_MS);
      shutdownReleaseTimer.ref?.();
    });
  };
  const testAckDelayMs = activeLaunch.env.PICKLE_TEST_MODE === '1'
    ? Math.max(0, Math.min(Number(activeLaunch.env.PICKLE_TEST_BROKER_ACK_DELAY_MS || 0), 5_000))
    : 0;
  if (testAckDelayMs > 0) {
    const timer = setTimeout(publishAcknowledgement, testAckDelayMs);
    timer.ref?.();
  } else {
    publishAcknowledgement();
  }
  }).catch((error) => {
    process.stderr.write(`Monitored descendant convergence crashed: ${String(error)}\n`);
    executeShutdown();
  });
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as NodeJS.Signals[]) {
  process.on(signal, () => {
    if (!launch) process.exit(125);
    if (!shuttingDown) beginShutdown(`broker-${signal}`, 500);
    // Once shutdown starts the broker intentionally swallows TERM so it can
    // perform the unconditional group KILL escalation itself.
  });
}

process.once('disconnect', () => {
  if (!launch) process.exit(125);
  beginShutdown('controller-disconnect', 500);
  executeShutdown();
});
setImmediate(() => {
  // disconnect can race module startup and occur before the listener above is
  // installed. The channel state is authoritative even when that edge was
  // missed.
  if (!process.connected && !launch) process.exit(125);
});

process.on('message', (raw: unknown) => {
  if (!raw || typeof raw !== 'object') return;
  const message = raw as Record<string, unknown>;

  if (message.type === 'terminate') {
    if (!launch || message.launch_id !== launch.launch_id
      || typeof message.cause !== 'string'
      || !Number.isFinite(message.grace_ms)) return;
    beginShutdown(message.cause, Number(message.grace_ms));
    return;
  }

  if (message.type === 'shutdown_release') {
    if (!launch || !shuttingDown || message.launch_id !== launch.launch_id
      || message.command_digest !== launch.command_digest) return;
    executeShutdown();
    return;
  }

  if (message.type === 'release') {
    if (!launch || message.launch_id !== launch.launch_id
      || message.command_digest !== launch.command_digest || targetReleased || !targetIdentity) return;
    if (process.platform !== 'win32') {
      const liveTarget = captureProcessLivenessIdentity(targetIdentity.pid);
      if (!liveTarget || !sameIdentity(liveTarget, targetIdentity)
        || liveTarget.pgid !== brokerIdentity?.pgid || !targetIsStopped(targetIdentity.pid)) {
        beginShutdown('target-release-identity-changed', 0);
        return;
      }
      try {
        process.kill(targetIdentity.pid, 'SIGCONT');
        targetReleased = true;
        send({
          type: 'released',
          launch_id: launch.launch_id,
          command_digest: launch.command_digest,
          broker_identity: brokerIdentity,
          target_identity: targetIdentity,
        });
      } catch { beginShutdown('target-release-failed', 0); }
    } else {
      targetReleased = true;
    }
    return;
  }

  if (message.type !== 'launch' || launch) return;
  if (typeof message.launch_id !== 'string' || message.launch_id.length < 16
    || typeof message.command_digest !== 'string'
    || typeof message.command !== 'string' || !message.command
    || !Array.isArray(message.args) || !message.args.every((arg: unknown) => typeof arg === 'string')
    || !message.env || typeof message.env !== 'object') {
    fail('Invalid monitored process broker launch request.');
  }
  const request = message as unknown as LaunchRequest;
  if (commandDigest(request) !== request.command_digest) fail('Monitored process broker command digest mismatch.');

  brokerIdentity = captureProcessLivenessIdentity(process.pid);
  if (!brokerIdentity || brokerIdentity.pid !== brokerIdentity.pgid) {
    fail('Monitored process broker could not attest its process-group identity.');
  }

  // Receipt of a valid authenticated launch is the release fence. The
  // controller sends it only after durably publishing brokerIdentity.
  launch = request;
  const guardianPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'monitored-target-guardian.js');
  const targetCommand = process.execPath;
  const targetArgs = [guardianPath, request.launch_id, request.command, ...request.args];
  target = spawn(targetCommand, targetArgs, {
    cwd: request.cwd,
    env: request.env,
    detached: false,
    stdio: 'inherit',
  });
  target.once('spawn', async () => {
    clearTimeout(registrationDeadline);
    if (!await waitForTargetStop(Number(target?.pid))) {
      beginShutdown('target-stop-attestation-failed', 0);
      return;
    }
    targetIdentity = captureProcessLivenessIdentity(Number(target?.pid));
    if (!targetIdentity || targetIdentity.pgid !== brokerIdentity?.pgid) {
      beginShutdown('target-identity-attestation-failed', 0);
      return;
    }
    send({
      type: 'launched',
      launch_id: request.launch_id,
      command_digest: request.command_digest,
      broker_identity: brokerIdentity,
      target_identity: targetIdentity,
    });
    if (process.platform === 'win32') targetReleased = true;
    else if (request.env.PICKLE_TEST_MODE !== '1'
      || request.env.PICKLE_TEST_DISABLE_DESCENDANT_TRACKER !== '1') {
      descendantTracker = setInterval(discoverDescendants, 10);
    }
  });
  target.once('error', (error) => {
    process.stderr.write(`${error.message}\n`);
    targetExitCode = 1;
    beginShutdown('target-spawn-error', 0);
  });
  target.once('exit', (code, signal) => {
    targetExitCode = code;
    targetSignal = signal;
    beginShutdown(signal ? `target-${signal}` : 'target-exit', 100);
  });
});
