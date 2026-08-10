/** Shared timing bounds for the authenticated monitored-process shutdown protocol. */
export const CONTROLLER_BROKER_FORCE_KILL_MARGIN_MS = 3_000;
export const PROCESS_IDENTITY_PS_TIMEOUT_MS = 5_000;
export const POST_CLOSE_ATTESTATION_WINDOW_MS = CONTROLLER_BROKER_FORCE_KILL_MARGIN_MS
  + (2 * PROCESS_IDENTITY_PS_TIMEOUT_MS);
export const MIN_POST_CLOSE_ATTESTATION_OBSERVATIONS = 2;

// A connected controller may be scheduler-starved while consuming the ack and
// completing one exact post-close inspection budget. Give it an additional
// bounded IPC/scheduler margin; a disconnected controller drains immediately.
export const SHUTDOWN_RELEASE_SCHEDULER_MARGIN_MS = 7_000;
export const BROKER_SHUTDOWN_RELEASE_TIMEOUT_MS = POST_CLOSE_ATTESTATION_WINDOW_MS
  + SHUTDOWN_RELEASE_SCHEDULER_MARGIN_MS;
export const CONTROLLER_BROKER_FORCE_KILL_TIMEOUT_MS = BROKER_SHUTDOWN_RELEASE_TIMEOUT_MS
  + CONTROLLER_BROKER_FORCE_KILL_MARGIN_MS;
