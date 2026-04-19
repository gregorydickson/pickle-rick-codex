const RUNNER_DESCRIPTORS = Object.freeze({
  pickle: Object.freeze({
    runnerBin: 'mux-runner.js',
    runnerLog: 'mux-runner.log',
    runnerStartMarker: 'mux-runner started',
    monitorMode: 'pickle',
  }),
  loop: Object.freeze({
    runnerBin: 'loop-runner.js',
    runnerLog: 'loop-runner.log',
    runnerStartMarker: 'loop-runner started',
    monitorMode: 'loop',
  }),
  pipeline: Object.freeze({
    runnerBin: 'pipeline-runner.js',
    runnerLog: 'pipeline-runner.log',
    runnerStartMarker: 'pipeline-runner started',
    monitorMode: 'pipeline',
  }),
});

export function normalizeRunnerMode(mode) {
  if (mode === 'pickle' || mode === 'pipeline') {
    return mode;
  }
  return 'loop';
}

export function getRunnerDescriptor(mode) {
  const runnerMode = normalizeRunnerMode(mode);
  return {
    mode: runnerMode,
    ...RUNNER_DESCRIPTORS[runnerMode],
  };
}

export function listRunnerDescriptors() {
  return structuredClone(RUNNER_DESCRIPTORS);
}
