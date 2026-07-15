export interface RunnerDescriptor {
  runnerBin: string;
  runnerLog: string;
  runnerStartMarker: string;
  monitorMode: string;
}

export type RunnerMode = 'pickle' | 'loop' | 'pipeline';

const RUNNER_DESCRIPTORS: Readonly<Record<RunnerMode, Readonly<RunnerDescriptor>>> = Object.freeze({
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

export function normalizeRunnerMode(mode: string): RunnerMode {
  if (mode === 'pickle' || mode === 'pipeline') {
    return mode;
  }
  return 'loop';
}

export interface NormalizedRunnerDescriptor extends RunnerDescriptor {
  mode: RunnerMode;
}

export function getRunnerDescriptor(mode: string): NormalizedRunnerDescriptor {
  const runnerMode = normalizeRunnerMode(mode);
  return {
    mode: runnerMode,
    ...RUNNER_DESCRIPTORS[runnerMode],
  };
}

export function listRunnerDescriptors(): Readonly<Record<RunnerMode, Readonly<RunnerDescriptor>>> {
  return structuredClone(RUNNER_DESCRIPTORS);
}
