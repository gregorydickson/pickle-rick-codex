import test from 'node:test';
import assert from 'node:assert/strict';
import { getRunnerDescriptor } from '../lib/runner-descriptors.js';

test('runner descriptors map advanced loop modes onto the shared loop runner', () => {
  const descriptor = getRunnerDescriptor('anatomy-park');
  assert.equal(descriptor.mode, 'loop');
  assert.equal(descriptor.runnerBin, 'loop-runner.js');
  assert.equal(descriptor.runnerLog, 'loop-runner.log');
  assert.equal(descriptor.runnerStartMarker, 'loop-runner started');
  assert.equal(descriptor.monitorMode, 'loop');
});

test('runner descriptors describe pipeline mode before the runner exists', () => {
  const descriptor = getRunnerDescriptor('pipeline');
  assert.equal(descriptor.mode, 'pipeline');
  assert.equal(descriptor.runnerBin, 'pipeline-runner.js');
  assert.equal(descriptor.runnerLog, 'pipeline-runner.log');
  assert.equal(descriptor.runnerStartMarker, 'pipeline-runner started');
  assert.equal(descriptor.monitorMode, 'pipeline');
});
