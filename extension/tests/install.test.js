// @tier: integration
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { projectRoot, makeTempRoot, runBash, runNode } from './helpers.js';

function countMatches(content, pattern) {
  return [...content.matchAll(pattern)].length;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function installerEnv(codexHome, installRoot, overrides = {}) {
  return {
    PICKLE_DATA_ROOT: installRoot,
    CODEX_HOME: codexHome,
    AGENTS_HOME: path.join(codexHome, 'agents-home'),
    PICKLE_INSTALL_SKIP_BUILD: '1',
    ...overrides,
  };
}

test('install.sh copies the runtime and installs the global persona and skills', () => {
  const codexHome = makeTempRoot('pickle-rick-codex-home-');
  const installRoot = path.join(codexHome, 'pickle-rick-runtime');
  const agentsHome = path.join(codexHome, 'agents-home');
  const projectDir = makeTempRoot('pickle-rick-project-');
  const realProjectDir = fs.realpathSync(projectDir);
  fs.mkdirSync(path.join(agentsHome, 'skills', 'existing-skill'), { recursive: true });
  fs.writeFileSync(path.join(agentsHome, 'skills', 'existing-skill', 'SKILL.md'), '---\nname: existing-skill\n---\n');
  fs.mkdirSync(path.join(codexHome, 'skills', 'pickle'), { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'skills', 'pickle', 'SKILL.md'), 'stale legacy pickle skill\n');
  fs.mkdirSync(path.join(codexHome, 'skills', 'unrelated-skill'), { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'skills', 'unrelated-skill', 'SKILL.md'), 'unrelated legacy skill\n');
  fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), '# Existing Global Instructions\n');
  fs.writeFileSync(path.join(codexHome, 'CLAUDE.md'), '# Existing Global Claude Instructions\n');
  const preexistingGlobalClaude = fs.readFileSync(path.join(codexHome, 'CLAUDE.md'), 'utf8');
  const output = runBash(['install.sh'], {
    cwd: projectRoot,
    env: installerEnv(codexHome, installRoot),
  });
  const canonicalInstallRoot = fs.realpathSync(installRoot);

  assert.match(output, /Installed Pickle Rick Codex runtime to:/);
  assert.match(output, /Installed Pickle Rick persona and skills into:/);
  assert.match(output, new RegExp(`node ${escapeRegex(canonicalInstallRoot)}/extension/bin/setup\\.js`));
  assert.ok(fs.existsSync(path.join(installRoot, 'extension', 'bin', 'setup.js')));
  assert.ok(fs.existsSync(path.join(installRoot, 'extension', 'bin', 'tmux-monitor.sh')));
  assert.ok(fs.existsSync(path.join(installRoot, 'extension', 'services', 'pickle-utils.js')));
  assert.ok(fs.existsSync(path.join(installRoot, 'extension', 'src', 'bin', 'spawn-morty.ts')));
  assert.ok(fs.existsSync(path.join(installRoot, 'extension', 'tests', 'helpers.js')));
  assert.equal(fs.existsSync(path.join(installRoot, 'extension', 'node_modules')), false);
  assert.equal(fs.existsSync(path.join(installRoot, 'extension', 'tsconfig.json')), false);
  assert.ok(fs.existsSync(path.join(installRoot, '.codex-plugin', 'plugin.json')));
  assert.ok(fs.existsSync(path.join(installRoot, 'skills', 'pickle', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(installRoot, '.codex', 'skills', 'pickle', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(installRoot, '.codex', 'skills', 'pickle-pipeline', 'SKILL.md')));
  assert.equal(fs.lstatSync(path.join(installRoot, '.codex', 'skills')).isSymbolicLink(), true);
  assert.ok(fs.existsSync(path.join(installRoot, '.codex', 'hooks', 'hooks.json')));
  assert.ok(fs.existsSync(path.join(installRoot, '.codex', 'hooks', 'hooks.template.json')));
  assert.ok(fs.existsSync(path.join(installRoot, '.pickle-rick-runtime')));
  assert.ok(fs.existsSync(path.join(installRoot, 'images', 'pickle-rick.png')));
  assert.equal(fs.existsSync(path.join(installRoot, 'tests')), false);
  assert.ok(fs.existsSync(path.join(codexHome, 'AGENTS.md')));
  assert.ok(fs.existsSync(path.join(agentsHome, 'skills', 'pickle', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(agentsHome, 'skills', 'pickle-pipeline', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(agentsHome, 'skills', 'pickle-refine', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(agentsHome, 'skills', 'pickle-tmux', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(agentsHome, 'skills', 'pickle-readiness', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(agentsHome, 'skills', 'anatomy-park', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(agentsHome, 'skills', 'existing-skill', 'SKILL.md')));
  assert.equal(fs.lstatSync(path.join(codexHome, 'skills', 'pickle')).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(codexHome, 'skills', 'pickle-readiness')).isSymbolicLink(), true);
  assert.equal(
    fs.readFileSync(path.join(codexHome, 'skills', 'pickle', 'SKILL.md'), 'utf8'),
    fs.readFileSync(path.join(agentsHome, 'skills', 'pickle', 'SKILL.md'), 'utf8'),
  );
  assert.equal(
    fs.readFileSync(path.join(codexHome, 'skills', 'unrelated-skill', 'SKILL.md'), 'utf8'),
    'unrelated legacy skill\n',
  );
  const legacySkillBackups = fs.readdirSync(path.join(codexHome, 'pickle-rick-backups', 'legacy-skills'));
  assert.ok(legacySkillBackups.some((entry) => entry.startsWith('pickle.') && entry.endsWith('.bak')));
  assert.match(
    fs.readFileSync(path.join(agentsHome, 'skills', 'pickle', 'SKILL.md'), 'utf8'),
    new RegExp(escapeRegex(canonicalInstallRoot)),
  );
  assert.match(
    fs.readFileSync(path.join(agentsHome, 'skills', 'pickle-pipeline', 'SKILL.md'), 'utf8'),
    new RegExp(escapeRegex(canonicalInstallRoot)),
  );
  const globalAgents = fs.readFileSync(path.join(codexHome, 'AGENTS.md'), 'utf8');
  const globalClaude = fs.readFileSync(path.join(codexHome, 'CLAUDE.md'), 'utf8');
  const installedReadme = fs.readFileSync(path.join(installRoot, 'README.md'), 'utf8');
  assert.match(globalAgents, /PICKLE_RICK_AGENTS_BEGIN/);
  assert.match(globalAgents, /# Existing Global Instructions/);
  assert.doesNotMatch(globalClaude, /PICKLE_RICK_CLAUDE_BEGIN/);
  assert.equal(globalClaude, preexistingGlobalClaude);
  assert.equal(fs.existsSync(path.join(installRoot, 'CLAUDE.md')), false);
  assert.match(globalAgents, new RegExp(escapeRegex(canonicalInstallRoot)));
  assert.doesNotMatch(globalAgents, /~\/\.codex\/pickle-rick/);
  assert.match(installedReadme, new RegExp(escapeRegex(canonicalInstallRoot)));
  assert.doesNotMatch(installedReadme, /~\/\.codex\/pickle-rick/);
  assert.ok(fs.existsSync(path.join(codexHome, 'pickle-rick-backups')));
  const installedPlugin = JSON.parse(fs.readFileSync(path.join(installRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
  assert.equal(installedPlugin.skills, './skills/');
  assert.equal('hooks' in installedPlugin, false);
  assert.equal('scripts' in installedPlugin, false);
  assert.equal(installedPlugin.author.name, 'Gregory Dickson');
  assert.equal(installedPlugin.interface.displayName, 'Pickle Rick Codex');
  assert.ok(fs.existsSync(path.join(installRoot, installedPlugin.skills, 'pickle-pipeline', 'SKILL.md')));
  const installedPackage = JSON.parse(fs.readFileSync(path.join(installRoot, 'package.json'), 'utf8'));
  assert.equal(installedPlugin.version, installedPackage.version);
  assert.equal(installedPackage.scripts.test, 'npm --prefix extension test');
  assert.ok(fs.readdirSync(path.join(installRoot, 'extension', 'tests')).filter((entry) => entry.endsWith('.test.js')).length > 0);

  const sessionDir = runNode(
    [path.join(installRoot, 'extension', 'bin', 'setup.js'), 'installed runtime smoke test'],
    { cwd: realProjectDir, env: installerEnv(codexHome, installRoot) },
  ).trim();
  assert.match(
    sessionDir,
    new RegExp(`^(?:${escapeRegex(installRoot)}|${escapeRegex(canonicalInstallRoot)})/sessions/`),
  );

  const resolved = runNode(
    [path.join(installRoot, 'extension', 'bin', 'get-session.js'), '--cwd', realProjectDir],
    { cwd: realProjectDir, env: installerEnv(codexHome, installRoot) },
  ).trim();
  assert.equal(resolved, sessionDir);
});

test('install.sh writes managed marker blocks on first install and remains idempotent', () => {
  const codexHome = makeTempRoot('pickle-rick-codex-home-');
  const installRoot = path.join(codexHome, 'pickle-rick-runtime');

  runBash(['install.sh'], {
    cwd: projectRoot,
    env: installerEnv(codexHome, installRoot),
  });

  const firstAgents = fs.readFileSync(path.join(codexHome, 'AGENTS.md'), 'utf8');
  assert.match(firstAgents, /PICKLE_RICK_AGENTS_BEGIN/);
  assert.equal(countMatches(firstAgents, /PICKLE_RICK_AGENTS_BEGIN/g), 1);
  assert.equal(countMatches(firstAgents, /PICKLE_RICK_AGENTS_END/g), 1);
  assert.equal(fs.existsSync(path.join(codexHome, 'CLAUDE.md')), false);

  runBash(['install.sh'], {
    cwd: projectRoot,
    env: installerEnv(codexHome, installRoot),
  });

  fs.writeFileSync(path.join(installRoot, 'CLAUDE.md'), '# stale runtime compatibility file\n');

  assert.equal(fs.readFileSync(path.join(codexHome, 'AGENTS.md'), 'utf8'), firstAgents);
  assert.equal(fs.existsSync(path.join(codexHome, 'CLAUDE.md')), false);
  assert.equal(fs.existsSync(path.join(installRoot, 'CLAUDE.md')), true);

  runBash(['install.sh'], {
    cwd: projectRoot,
    env: installerEnv(codexHome, installRoot),
  });

  assert.equal(fs.existsSync(path.join(installRoot, 'CLAUDE.md')), false);
});

test('install.sh --project preserves existing project codex state while adding repo-local overrides', () => {
  const codexHome = makeTempRoot('pickle-rick-codex-home-');
  const installRoot = path.join(codexHome, 'pickle-rick-runtime');
  const projectDir = makeTempRoot('pickle-rick-project-');
  fs.mkdirSync(path.join(projectDir, '.agents', 'skills', 'existing-skill'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.agents', 'skills', 'existing-skill', 'SKILL.md'), '---\nname: existing-skill\n---\n');
  fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), '# Existing Instructions\n');
  fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# Existing Claude Instructions\n');
  const preexistingProjectClaude = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf8');

  const output = runBash(['install.sh', '--project', projectDir], {
    cwd: projectRoot,
    env: installerEnv(codexHome, installRoot),
  });

  assert.match(output, /global Pickle Rick install remains available in every workspace/);
  assert.ok(fs.existsSync(path.join(projectDir, 'AGENTS.md')));
  assert.ok(fs.existsSync(path.join(projectDir, '.agents', 'skills', 'pickle', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(projectDir, '.agents', 'skills', 'pickle-pipeline', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(projectDir, '.agents', 'skills', 'pickle-refine', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(projectDir, '.agents', 'skills', 'pickle-tmux', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(projectDir, '.agents', 'skills', 'anatomy-park', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(projectDir, '.agents', 'skills', 'existing-skill', 'SKILL.md')));
  assert.equal(fs.existsSync(path.join(projectDir, '.codex', 'hooks', 'hooks.json')), false);
  assert.match(
    fs.readFileSync(path.join(projectDir, '.agents', 'skills', 'pickle', 'SKILL.md'), 'utf8'),
    new RegExp(escapeRegex(installRoot)),
  );
  assert.match(
    fs.readFileSync(path.join(projectDir, '.agents', 'skills', 'pickle-pipeline', 'SKILL.md'), 'utf8'),
    new RegExp(escapeRegex(installRoot)),
  );
  const projectAgents = fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf8');
  const projectClaude = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf8');
  assert.match(projectAgents, /PICKLE_RICK_AGENTS_BEGIN/);
  assert.match(projectAgents, /# Existing Instructions/);
  assert.doesNotMatch(projectClaude, /PICKLE_RICK_CLAUDE_BEGIN/);
  assert.equal(projectClaude, preexistingProjectClaude);
  assert.match(projectAgents, new RegExp(escapeRegex(installRoot)));
  assert.doesNotMatch(projectAgents, /~\/\.codex\/pickle-rick/);
  assert.ok(fs.existsSync(path.join(projectDir, '.codex', 'pickle-rick-backups')));
});

test('installed runtime install.sh supports documented --project usage', () => {
  const codexHome = makeTempRoot('pickle-rick-codex-home-');
  const installRoot = path.join(codexHome, 'pickle-rick-runtime');
  const projectDir = makeTempRoot('pickle-rick-project-');
  fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), '# Existing Project Instructions\n');

  runBash(['install.sh'], {
    cwd: projectRoot,
    env: installerEnv(codexHome, installRoot),
  });

  const output = runBash([path.join(installRoot, 'install.sh'), '--project', projectDir], {
    cwd: installRoot,
    env: installerEnv(codexHome, installRoot),
  });

  assert.match(output, /Copied project-facing Pickle Rick assets to:/);
  assert.match(output, /hook installation is disabled pending authenticated validation/);
  assert.ok(fs.existsSync(path.join(projectDir, '.agents', 'skills', 'pickle', 'SKILL.md')));
  assert.equal(fs.existsSync(path.join(projectDir, '.codex', 'hooks.json')), false);
  assert.equal(fs.existsSync(path.join(projectDir, '.codex', 'hooks', 'hooks.json')), false);
  const projectAgents = fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf8');
  assert.match(projectAgents, /PICKLE_RICK_AGENTS_BEGIN/);
  assert.match(projectAgents, new RegExp(escapeRegex(installRoot)));
  assert.doesNotMatch(projectAgents, /~\/\.codex\/pickle-rick/);
});

test('install.sh rejects --enable-hooks before changing the target project', () => {
  const codexHome = makeTempRoot('pickle-rick-codex-home-');
  const installRoot = path.join(codexHome, 'pickle-rick-runtime');
  const projectDir = makeTempRoot('pickle-rick-project-');
  fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), '# untouched\n');
  assert.throws(
    () => runBash(['install.sh', '--project', projectDir, '--enable-hooks'], {
      cwd: projectRoot,
      env: installerEnv(codexHome, installRoot),
    }),
    /--enable-hooks is unsupported.*authenticated validation/,
  );
  assert.equal(fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf8'), '# untouched\n');
  assert.equal(fs.existsSync(installRoot), false);
});

test('install.sh rejects broad or unrelated runtime targets before deletion', () => {
  const fakeHome = makeTempRoot('pickle-rick-install-home-');
  const codexHome = path.join(fakeHome, '.codex');
  const unrelatedRoot = path.join(fakeHome, 'unrelated-runtime');
  fs.mkdirSync(unrelatedRoot);
  fs.writeFileSync(path.join(unrelatedRoot, 'keep.txt'), 'preserve me\n');

  assert.throws(
    () => runBash(['install.sh'], {
      cwd: projectRoot,
      env: installerEnv(fakeHome, path.join(fakeHome, 'runtime'), { HOME: fakeHome }),
    }),
    /Refusing unsafe CODEX_HOME target/,
  );
  assert.throws(
    () => runBash(['install.sh'], {
      cwd: projectRoot,
      env: installerEnv(codexHome, path.join(fakeHome, 'runtime'), { HOME: fakeHome, AGENTS_HOME: fakeHome }),
    }),
    /Refusing unsafe AGENTS_HOME target/,
  );

  assert.throws(
    () => runBash(['install.sh'], {
      cwd: projectRoot,
      env: installerEnv(codexHome, fakeHome, { HOME: fakeHome }),
    }),
    /Refusing unsafe PICKLE_DATA_ROOT target/,
  );
  assert.throws(
    () => runBash(['install.sh'], {
      cwd: projectRoot,
      env: installerEnv(codexHome, codexHome, { HOME: fakeHome }),
    }),
    /Refusing unsafe PICKLE_DATA_ROOT target/,
  );
  assert.throws(
    () => runBash(['install.sh'], {
      cwd: projectRoot,
      env: installerEnv(codexHome, unrelatedRoot, { HOME: fakeHome }),
    }),
    /Refusing to replace non-Pickle-Rick directory/,
  );
  assert.equal(fs.readFileSync(path.join(unrelatedRoot, 'keep.txt'), 'utf8'), 'preserve me\n');
});

test('install.sh resolves symlinks before applying destructive target guards', () => {
  const fakeHome = makeTempRoot('pickle-rick-install-home-');
  const codexHome = path.join(fakeHome, '.codex');
  const symlinkTarget = path.join(path.dirname(fakeHome), `${path.basename(fakeHome)}-link`);
  fs.symlinkSync(fakeHome, symlinkTarget, 'dir');

  assert.throws(
    () => runBash(['install.sh'], {
      cwd: projectRoot,
      env: installerEnv(codexHome, symlinkTarget, { HOME: fakeHome }),
    }),
    /Refusing unsafe PICKLE_DATA_ROOT target/,
  );
});

test('install.sh rejects unknown arguments', () => {
  const codexHome = makeTempRoot('pickle-rick-codex-home-');
  const installRoot = path.join(codexHome, 'pickle-rick-runtime');
  assert.throws(
    () => runBash(['install.sh', '--bogus'], { cwd: projectRoot, env: installerEnv(codexHome, installRoot) }),
    /Unknown argument: --bogus/,
  );
});
