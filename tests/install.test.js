import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot, makeTempRoot, runBash, runNode } from './helpers.js';

test('install.sh copies the runtime and installs the global persona and skills', () => {
  const codexHome = makeTempRoot('pickle-rick-codex-home-');
  const installRoot = path.join(codexHome, 'pickle-rick-runtime');
  const projectDir = makeTempRoot('pickle-rick-project-');
  const realProjectDir = fs.realpathSync(projectDir);
  fs.mkdirSync(path.join(codexHome, 'skills', 'existing-skill'), { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'skills', 'existing-skill', 'SKILL.md'), '---\nname: existing-skill\n---\n');
  fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), '# Existing Global Instructions\n');
  fs.writeFileSync(path.join(codexHome, 'CLAUDE.md'), '# Existing Global Claude Instructions\n');
  const output = runBash(['install.sh'], {
    cwd: repoRoot,
    env: { PICKLE_DATA_ROOT: installRoot, CODEX_HOME: codexHome },
  });

  assert.match(output, /Installed Pickle Rick Codex runtime to:/);
  assert.match(output, /Installed Pickle Rick persona and skills into:/);
  assert.match(output, new RegExp(`node ${installRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/bin/setup\\.js`));
  assert.ok(fs.existsSync(path.join(installRoot, 'bin', 'setup.js')));
  assert.ok(fs.existsSync(path.join(installRoot, '.codex-plugin', 'plugin.json')));
  assert.ok(fs.existsSync(path.join(codexHome, 'AGENTS.md')));
  assert.ok(fs.existsSync(path.join(codexHome, 'CLAUDE.md')));
  assert.ok(fs.existsSync(path.join(codexHome, 'skills', 'pickle', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(codexHome, 'skills', 'pickle-refine', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(codexHome, 'skills', 'pickle-tmux', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(codexHome, 'skills', 'anatomy-park', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(codexHome, 'skills', 'existing-skill', 'SKILL.md')));
  assert.match(
    fs.readFileSync(path.join(codexHome, 'skills', 'pickle', 'SKILL.md'), 'utf8'),
    new RegExp(installRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
  assert.match(fs.readFileSync(path.join(codexHome, 'AGENTS.md'), 'utf8'), /PICKLE_RICK_AGENTS_BEGIN/);
  assert.match(fs.readFileSync(path.join(codexHome, 'AGENTS.md'), 'utf8'), /# Existing Global Instructions/);
  assert.match(fs.readFileSync(path.join(codexHome, 'CLAUDE.md'), 'utf8'), /PICKLE_RICK_CLAUDE_BEGIN/);
  assert.ok(fs.existsSync(path.join(codexHome, 'pickle-rick-backups')));

  const sessionDir = runNode(
    [path.join(installRoot, 'bin', 'setup.js'), 'installed runtime smoke test'],
    { cwd: realProjectDir, env: { PICKLE_DATA_ROOT: installRoot, CODEX_HOME: codexHome } },
  ).trim();
  assert.match(sessionDir, new RegExp(`^${installRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/sessions/`));

  const resolved = runNode(
    [path.join(installRoot, 'bin', 'get-session.js'), '--cwd', realProjectDir],
    { cwd: realProjectDir, env: { PICKLE_DATA_ROOT: installRoot, CODEX_HOME: codexHome } },
  ).trim();
  assert.equal(resolved, sessionDir);
});

test('install.sh --project preserves existing project codex state while adding repo-local overrides', () => {
  const codexHome = makeTempRoot('pickle-rick-codex-home-');
  const installRoot = path.join(codexHome, 'pickle-rick-runtime');
  const projectDir = makeTempRoot('pickle-rick-project-');
  fs.mkdirSync(path.join(projectDir, '.codex', 'skills', 'existing-skill'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.codex', 'skills', 'existing-skill', 'SKILL.md'), '---\nname: existing-skill\n---\n');
  fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), '# Existing Instructions\n');
  fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# Existing Claude Instructions\n');

  const output = runBash(['install.sh', '--project', projectDir], {
    cwd: repoRoot,
    env: { PICKLE_DATA_ROOT: installRoot, CODEX_HOME: codexHome },
  });

  assert.match(output, /global Pickle Rick install remains available in every workspace/);
  assert.ok(fs.existsSync(path.join(projectDir, 'AGENTS.md')));
  assert.ok(fs.existsSync(path.join(projectDir, '.codex', 'skills', 'pickle', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(projectDir, '.codex', 'skills', 'pickle-refine', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(projectDir, '.codex', 'skills', 'pickle-tmux', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(projectDir, '.codex', 'skills', 'anatomy-park', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(projectDir, '.codex', 'skills', 'existing-skill', 'SKILL.md')));
  assert.equal(fs.existsSync(path.join(projectDir, '.codex', 'hooks', 'hooks.json')), false);
  assert.match(
    fs.readFileSync(path.join(projectDir, '.codex', 'skills', 'pickle', 'SKILL.md'), 'utf8'),
    new RegExp(installRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
  assert.match(fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf8'), /PICKLE_RICK_AGENTS_BEGIN/);
  assert.match(fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf8'), /# Existing Instructions/);
  assert.match(fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf8'), /PICKLE_RICK_CLAUDE_BEGIN/);
  assert.ok(fs.existsSync(path.join(projectDir, '.codex', 'pickle-rick-backups')));
});

test('install.sh --enable-hooks renders project hooks to the installed runtime root', () => {
  const codexHome = makeTempRoot('pickle-rick-codex-home-');
  const installRoot = path.join(codexHome, 'pickle-rick-runtime');
  const projectDir = makeTempRoot('pickle-rick-project-');
  const output = runBash(['install.sh', '--project', projectDir, '--enable-hooks'], {
    cwd: repoRoot,
    env: { PICKLE_DATA_ROOT: installRoot, CODEX_HOME: codexHome },
  });

  assert.match(output, /project-local hooks were installed from a rendered template/);
  const hooksPath = path.join(projectDir, '.codex', 'hooks', 'hooks.json');
  assert.ok(fs.existsSync(hooksPath));
  const hooksContent = fs.readFileSync(hooksPath, 'utf8');
  assert.match(hooksContent, new RegExp(installRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(hooksContent, /\$HOME\/\.codex\/pickle-rick/);
});

test('install.sh rejects unknown arguments', () => {
  const codexHome = makeTempRoot('pickle-rick-codex-home-');
  const installRoot = path.join(codexHome, 'pickle-rick-runtime');
  assert.throws(
    () => runBash(['install.sh', '--bogus'], { cwd: repoRoot, env: { PICKLE_DATA_ROOT: installRoot, CODEX_HOME: codexHome } }),
    /Unknown argument: --bogus/,
  );
});
