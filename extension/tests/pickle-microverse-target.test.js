// @tier: integration
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  createFakeTmux,
  makeTempRoot,
  prependPath,
  repoRoot,
  runNode,
} from './helpers.js';

test('pickle-microverse persists a validated numeric target contract', () => {
  const dataRoot = makeTempRoot('pickle-microverse-target-data-');
  const projectDir = makeTempRoot('pickle-microverse-target-project-');
  const fakeBin = makeTempRoot('pickle-microverse-target-bin-');
  createFakeTmux(fakeBin);
  const env = prependPath(fakeBin, { PICKLE_DATA_ROOT: dataRoot });

  const output = runNode([
    path.join(repoRoot, 'bin/pickle-microverse.js'),
    '--metric', 'echo 42',
    '--task', 'improve score',
    '--direction', 'higher',
    '--target', '90.5',
    '--target-relation', 'gt',
    '--protected-path', 'extension/bin/test-runner.js',
    '--protected-path', 'extension/services/**',
    '--worker-failure-limit', '4',
  ], { cwd: projectDir, env });
  const statePath = output.match(/^State: (.+)$/m)?.[1];
  assert.ok(statePath);
  const config = JSON.parse(fs.readFileSync(path.join(path.dirname(statePath), 'loop_config.json'), 'utf8'));
  assert.equal(config.target, 90.5);
  assert.equal(config.target_relation, 'gt');
  assert.deepEqual(config.protected_paths, ['extension/bin/test-runner.js', 'extension/services/**']);
  assert.equal(config.worker_failure_limit, 4);
});

test('pickle-microverse rejects invalid target contracts before launch', () => {
  const projectDir = makeTempRoot('pickle-microverse-invalid-target-');
  const cli = path.join(repoRoot, 'bin/pickle-microverse.js');
  const common = [cli, '--metric', 'echo 42', '--task', 'improve score'];

  assert.throws(
    () => runNode([...common, '--target', '90', '--target-relation', 'lt'], { cwd: projectDir }),
    /incompatible with direction higher/,
  );
  assert.throws(
    () => runNode([...common, '--target', 'not-a-number', '--target-relation', 'gt'], { cwd: projectDir }),
    /finite number/,
  );
  assert.throws(
    () => runNode([...common, '--target', '90'], { cwd: projectDir }),
    /requires --target-relation/,
  );
  assert.throws(
    () => runNode([
      cli,
      '--goal', 'reach ninety',
      '--task', 'improve score',
      '--target', '90',
      '--target-relation', 'gte',
    ], { cwd: projectDir }),
    /--target requires --metric/,
  );
  assert.throws(
    () => runNode([...common, '--protected-path', ''], { cwd: projectDir }),
    /--protected-path requires/,
  );
  assert.throws(
    () => runNode([...common, '--worker-failure-limit', '0'], { cwd: projectDir }),
    /positive integer/,
  );
});

test('pickle-microverse rejects a numeric target change on resume before relaunch', () => {
  const dataRoot = makeTempRoot('pickle-microverse-resume-target-data-');
  const projectDir = makeTempRoot('pickle-microverse-resume-target-project-');
  const fakeBin = makeTempRoot('pickle-microverse-resume-target-bin-');
  createFakeTmux(fakeBin);
  const env = prependPath(fakeBin, { PICKLE_DATA_ROOT: dataRoot });
  const cli = path.join(repoRoot, 'bin/pickle-microverse.js');
  const output = runNode([
    cli, '--metric', 'echo 42', '--task', 'improve score', '--direction', 'higher',
    '--target', '90', '--target-relation', 'gte',
  ], { cwd: projectDir, env });
  const statePath = output.match(/^State: (.+)$/m)?.[1];
  assert.ok(statePath);
  const sessionDir = path.dirname(statePath);

  assert.throws(
    () => runNode([
      cli, '--resume', sessionDir, '--direction', 'higher', '--target', '91', '--target-relation', 'gte',
    ], { cwd: projectDir, env }),
    /Cannot change numeric target when resuming microverse/,
  );
  const config = JSON.parse(fs.readFileSync(path.join(sessionDir, 'loop_config.json'), 'utf8'));
  assert.equal(config.target, 90);
  assert.equal(config.target_relation, 'gte');
});
