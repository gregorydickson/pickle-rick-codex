import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot, makeTempRoot, runBash, runNode } from './helpers.js';

function countMatches(content, pattern) {
  return [...content.matchAll(pattern)].length;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
  assert.match(output, new RegExp(`node ${escapeRegex(installRoot)}/bin/setup\\.js`));
  assert.ok(fs.existsSync(path.join(installRoot, 'bin', 'setup.js')));
  assert.ok(fs.existsSync(path.join(installRoot, '.codex-plugin', 'plugin.json')));
  assert.ok(fs.existsSync(path.join(installRoot, '.codex', 'skills', 'pickle', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(installRoot, '.codex', 'hooks', 'hooks.json')));
  assert.ok(fs.existsSync(path.join(installRoot, '.codex', 'hooks', 'hooks.template.json')));
  assert.ok(fs.existsSync(path.join(installRoot, 'images', 'pickle-rick.png')));
  assert.ok(fs.existsSync(path.join(installRoot, 'tests', 'install.test.js')));
  assert.ok(fs.existsSync(path.join(installRoot, 'tests', 'helpers.js')));
  assert.ok(fs.existsSync(path.join(codexHome, 'AGENTS.md')));
  assert.ok(fs.existsSync(path.join(codexHome, 'CLAUDE.md')));
  assert.ok(fs.existsSync(path.join(codexHome, 'skills', 'pickle', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(codexHome, 'skills', 'pickle-refine', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(codexHome, 'skills', 'pickle-tmux', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(codexHome, 'skills', 'anatomy-park', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(codexHome, 'skills', 'existing-skill', 'SKILL.md')));
  assert.match(
    fs.readFileSync(path.join(codexHome, 'skills', 'pickle', 'SKILL.md'), 'utf8'),
    new RegExp(escapeRegex(installRoot)),
  );
  const globalAgents = fs.readFileSync(path.join(codexHome, 'AGENTS.md'), 'utf8');
  const globalClaude = fs.readFileSync(path.join(codexHome, 'CLAUDE.md'), 'utf8');
  const installedReadme = fs.readFileSync(path.join(installRoot, 'README.md'), 'utf8');
  assert.match(globalAgents, /PICKLE_RICK_AGENTS_BEGIN/);
  assert.match(globalAgents, /# Existing Global Instructions/);
  assert.match(globalClaude, /PICKLE_RICK_CLAUDE_BEGIN/);
  assert.match(globalAgents, new RegExp(escapeRegex(installRoot)));
  assert.match(globalClaude, new RegExp(escapeRegex(installRoot)));
  assert.doesNotMatch(globalAgents, /~\/\.codex\/pickle-rick/);
  assert.doesNotMatch(globalClaude, /~\/\.codex\/pickle-rick/);
  assert.match(installedReadme, new RegExp(escapeRegex(installRoot)));
  assert.doesNotMatch(installedReadme, /~\/\.codex\/pickle-rick/);
  assert.ok(fs.existsSync(path.join(codexHome, 'pickle-rick-backups')));
  const installedPlugin = JSON.parse(fs.readFileSync(path.join(installRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
  assert.equal(installedPlugin.hooks, '.codex/hooks/hooks.json');
  assert.ok(fs.existsSync(path.join(installRoot, installedPlugin.hooks)));
  const installedPackage = JSON.parse(fs.readFileSync(path.join(installRoot, 'package.json'), 'utf8'));
  assert.equal(installedPlugin.version, installedPackage.version);
  assert.equal(installedPackage.scripts.test, 'node --test tests/*.test.js');
  assert.ok(fs.readdirSync(path.join(installRoot, 'tests')).filter((entry) => entry.endsWith('.test.js')).length > 0);

  const sessionDir = runNode(
    [path.join(installRoot, 'bin', 'setup.js'), 'installed runtime smoke test'],
    { cwd: realProjectDir, env: { PICKLE_DATA_ROOT: installRoot, CODEX_HOME: codexHome } },
  ).trim();
  assert.match(sessionDir, new RegExp(`^${escapeRegex(installRoot)}/sessions/`));

  const resolved = runNode(
    [path.join(installRoot, 'bin', 'get-session.js'), '--cwd', realProjectDir],
    { cwd: realProjectDir, env: { PICKLE_DATA_ROOT: installRoot, CODEX_HOME: codexHome } },
  ).trim();
  assert.equal(resolved, sessionDir);
});

test('install.sh writes managed marker blocks on first install and remains idempotent', () => {
  const codexHome = makeTempRoot('pickle-rick-codex-home-');
  const installRoot = path.join(codexHome, 'pickle-rick-runtime');

  runBash(['install.sh'], {
    cwd: repoRoot,
    env: { PICKLE_DATA_ROOT: installRoot, CODEX_HOME: codexHome },
  });

  const firstAgents = fs.readFileSync(path.join(codexHome, 'AGENTS.md'), 'utf8');
  const firstClaude = fs.readFileSync(path.join(codexHome, 'CLAUDE.md'), 'utf8');
  assert.match(firstAgents, /PICKLE_RICK_AGENTS_BEGIN/);
  assert.match(firstClaude, /PICKLE_RICK_CLAUDE_BEGIN/);
  assert.equal(countMatches(firstAgents, /PICKLE_RICK_AGENTS_BEGIN/g), 1);
  assert.equal(countMatches(firstAgents, /PICKLE_RICK_AGENTS_END/g), 1);
  assert.equal(countMatches(firstClaude, /PICKLE_RICK_CLAUDE_BEGIN/g), 1);
  assert.equal(countMatches(firstClaude, /PICKLE_RICK_CLAUDE_END/g), 1);

  runBash(['install.sh'], {
    cwd: repoRoot,
    env: { PICKLE_DATA_ROOT: installRoot, CODEX_HOME: codexHome },
  });

  assert.equal(fs.readFileSync(path.join(codexHome, 'AGENTS.md'), 'utf8'), firstAgents);
  assert.equal(fs.readFileSync(path.join(codexHome, 'CLAUDE.md'), 'utf8'), firstClaude);
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
    new RegExp(escapeRegex(installRoot)),
  );
  const projectAgents = fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf8');
  const projectClaude = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf8');
  assert.match(projectAgents, /PICKLE_RICK_AGENTS_BEGIN/);
  assert.match(projectAgents, /# Existing Instructions/);
  assert.match(projectClaude, /PICKLE_RICK_CLAUDE_BEGIN/);
  assert.match(projectAgents, new RegExp(escapeRegex(installRoot)));
  assert.match(projectClaude, new RegExp(escapeRegex(installRoot)));
  assert.doesNotMatch(projectAgents, /~\/\.codex\/pickle-rick/);
  assert.doesNotMatch(projectClaude, /~\/\.codex\/pickle-rick/);
  assert.ok(fs.existsSync(path.join(projectDir, '.codex', 'pickle-rick-backups')));
});

test('installed runtime install.sh supports documented --project usage', () => {
  const codexHome = makeTempRoot('pickle-rick-codex-home-');
  const installRoot = path.join(codexHome, 'pickle-rick-runtime');
  const projectDir = makeTempRoot('pickle-rick-project-');
  fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), '# Existing Project Instructions\n');

  runBash(['install.sh'], {
    cwd: repoRoot,
    env: { PICKLE_DATA_ROOT: installRoot, CODEX_HOME: codexHome },
  });

  const output = runBash([path.join(installRoot, 'install.sh'), '--project', projectDir, '--enable-hooks'], {
    cwd: installRoot,
    env: { PICKLE_DATA_ROOT: installRoot, CODEX_HOME: codexHome },
  });

  assert.match(output, /Copied project-facing \.codex assets to:/);
  assert.match(output, /project-local hooks were installed from a rendered template/);
  assert.ok(fs.existsSync(path.join(projectDir, '.codex', 'skills', 'pickle', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(projectDir, '.codex', 'hooks', 'hooks.json')));
  const projectAgents = fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf8');
  assert.match(projectAgents, /PICKLE_RICK_AGENTS_BEGIN/);
  assert.match(projectAgents, new RegExp(escapeRegex(installRoot)));
  assert.doesNotMatch(projectAgents, /~\/\.codex\/pickle-rick/);
  const hooksContent = fs.readFileSync(path.join(projectDir, '.codex', 'hooks', 'hooks.json'), 'utf8');
  assert.match(hooksContent, new RegExp(escapeRegex(installRoot)));
  assert.doesNotMatch(hooksContent, /\$HOME\/\.codex\/pickle-rick/);
  assert.doesNotMatch(hooksContent, /~\/\.codex\/pickle-rick/);
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
  assert.match(hooksContent, new RegExp(escapeRegex(installRoot)));
  assert.doesNotMatch(hooksContent, /\$HOME\/\.codex\/pickle-rick/);
  assert.doesNotMatch(hooksContent, /~\/\.codex\/pickle-rick/);
});

test('install.sh rejects unknown arguments', () => {
  const codexHome = makeTempRoot('pickle-rick-codex-home-');
  const installRoot = path.join(codexHome, 'pickle-rick-runtime');
  assert.throws(
    () => runBash(['install.sh', '--bogus'], { cwd: repoRoot, env: { PICKLE_DATA_ROOT: installRoot, CODEX_HOME: codexHome } }),
    /Unknown argument: --bogus/,
  );
});
