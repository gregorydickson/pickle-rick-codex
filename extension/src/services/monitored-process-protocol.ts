/** Shared timing bounds for the authenticated monitored-process shutdown protocol. */
export const CONTROLLER_BROKER_FORCE_KILL_MARGIN_MS = 3_000;
export const PROCESS_IDENTITY_PS_TIMEOUT_MS = 5_000;
export const POST_CLOSE_ATTESTATION_WINDOW_MS = CONTROLLER_BROKER_FORCE_KILL_MARGIN_MS
  + (2 * PROCESS_IDENTITY_PS_TIMEOUT_MS);
export const MIN_POST_CLOSE_ATTESTATION_OBSERVATIONS = 2;

// A stop probe is a blocking OS inspection. Under host load one failed probe
// can consume its full timeout, so the attestation window must guarantee more
// than one observation before rejecting a correctly stopped guardian.
export const TARGET_STOP_PROBE_TIMEOUT_MS = 2_000;
export const MIN_TARGET_STOP_ATTESTATION_OBSERVATIONS = 2;
export const TARGET_STOP_ATTESTATION_WINDOW_MS =
  (MIN_TARGET_STOP_ATTESTATION_OBSERVATIONS * TARGET_STOP_PROBE_TIMEOUT_MS) + 3_000;

// A connected controller may be scheduler-starved while consuming the ack and
// completing one exact post-close inspection budget. Give it an additional
// bounded IPC/scheduler margin; a disconnected controller drains immediately.
export const SHUTDOWN_RELEASE_SCHEDULER_MARGIN_MS = 7_000;
export const BROKER_SHUTDOWN_RELEASE_TIMEOUT_MS = POST_CLOSE_ATTESTATION_WINDOW_MS
  + SHUTDOWN_RELEASE_SCHEDULER_MARGIN_MS;
export const CONTROLLER_BROKER_FORCE_KILL_TIMEOUT_MS = BROKER_SHUTDOWN_RELEASE_TIMEOUT_MS
  + CONTROLLER_BROKER_FORCE_KILL_MARGIN_MS;
// Authenticated material convergence progress renews this lease. Silence or
// replayed/non-advancing progress still reaches the bounded force-kill path.
export const BROKER_CONVERGENCE_PROGRESS_STALL_TIMEOUT_MS = 30_000;
