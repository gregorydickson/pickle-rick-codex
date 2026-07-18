#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
codex_home="${CODEX_HOME:-$HOME/.codex}"
agents_home="${AGENTS_HOME:-$HOME/.agents}"
target_root="${PICKLE_DATA_ROOT:-$codex_home/pickle-rick}"
project_dir=""
enable_hooks=0
project_is_source=0
runtime_is_installed_source=0
repo_is_checkout=0

require_command() {
  local command_name="$1"
  local install_hint="$2"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name. $install_hint" >&2
    exit 1
  fi
}

require_command node "Install Node.js 20 or newer."
require_command npm "Install npm with Node.js 20 or newer."
require_command rsync "Install rsync before running the installer."

node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [[ "$node_major" -lt 20 ]]; then
  echo "Pickle Rick requires Node.js 20 or newer; found $(node --version)." >&2
  exit 1
fi

usage() {
  cat <<'EOF'
Usage:
  bash install.sh
  bash install.sh --project /path/to/project

The former --enable-hooks option is rejected until the installed Codex hook
event, payload, decision, and trust contracts have authenticated validation.
EOF
}

canonicalize_path() {
  node - "$1" <<'EOF'
const fs = require('node:fs');
const path = require('node:path');

let candidate = path.resolve(process.argv[2]);
const missing = [];
while (!fs.existsSync(candidate)) {
  const parent = path.dirname(candidate);
  if (parent === candidate) break;
  missing.unshift(path.basename(candidate));
  candidate = parent;
}
const resolved = fs.existsSync(candidate) ? fs.realpathSync(candidate) : candidate;
process.stdout.write(path.join(resolved, ...missing));
EOF
}

is_same_or_ancestor() {
  local possible_ancestor="$1"
  local candidate="$2"
  [[ "$candidate" == "$possible_ancestor" || "$candidate" == "$possible_ancestor/"* ]]
}

assert_safe_install_roots() {
  local canonical_home
  canonical_home="$(canonicalize_path "$HOME")"

  if [[ "$codex_home" == "/" || "$codex_home" == "$canonical_home" ]] \
    || is_same_or_ancestor "$codex_home" "$canonical_home" \
    || [[ "$codex_home" == "$repo_root" ]]; then
    echo "Refusing unsafe CODEX_HOME target: $codex_home" >&2
    exit 1
  fi

  if [[ "$agents_home" == "/" || "$agents_home" == "$canonical_home" || "$agents_home" == "$codex_home" ]] \
    || is_same_or_ancestor "$agents_home" "$canonical_home" \
    || [[ "$agents_home" == "$repo_root" ]]; then
    echo "Refusing unsafe AGENTS_HOME target: $agents_home" >&2
    exit 1
  fi

  if [[ "$target_root" == "/" || "$target_root" == "$canonical_home" || "$target_root" == "$codex_home" || "$target_root" == "$agents_home" ]] \
    || is_same_or_ancestor "$target_root" "$canonical_home" \
    || { [[ "$target_root" == "$repo_root" ]] && [[ -d "$repo_root/.git" ]]; }; then
    echo "Refusing unsafe PICKLE_DATA_ROOT target: $target_root" >&2
    exit 1
  fi

  if [[ -d "$target_root" ]] && [[ -n "$(find "$target_root" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
    local marker="$target_root/.pickle-rick-runtime"
    local package_name=""
    local plugin_name=""
    if [[ -f "$target_root/package.json" ]]; then
      package_name="$(node -e 'try { process.stdout.write(String(require(process.argv[1]).name || "")); } catch {}' "$target_root/package.json")"
    fi
    if [[ -f "$target_root/.codex-plugin/plugin.json" ]]; then
      plugin_name="$(node -e 'try { process.stdout.write(String(require(process.argv[1]).name || "")); } catch {}' "$target_root/.codex-plugin/plugin.json")"
    fi
    if [[ ! -f "$marker" && "$package_name" != "pickle-rick-codex" && "$plugin_name" != "pickle-rick-codex" ]]; then
      echo "Refusing to replace non-Pickle-Rick directory: $target_root" >&2
      exit 1
    fi
  fi
}

backup_path() {
  local target="$1"
  local backup_dir="$2"
  local basename
  basename="$(basename "$target")"
  mkdir -p "$backup_dir"
  printf '%s/%s.%s.bak' "$backup_dir" "$basename" "$(date +%s)"
}

merge_managed_markdown() {
  local source_file="$1"
  local target_file="$2"
  local label="$3"
  local backup_dir="$4"

  node - "$source_file" "$target_file" "$label" "$backup_dir" <<'EOF'
const fs = require('node:fs');
const path = require('node:path');

const [sourceFile, targetFile, label, backupDir] = process.argv.slice(2);
const source = fs.readFileSync(sourceFile, 'utf8').trimEnd();
const start = `<!-- PICKLE_RICK_${label.toUpperCase()}_BEGIN -->`;
const end = `<!-- PICKLE_RICK_${label.toUpperCase()}_END -->`;
const block = `${start}\n${source}\n${end}`;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function backupCurrent() {
  fs.mkdirSync(backupDir, { recursive: true });
  const backupFile = path.join(backupDir, `${path.basename(targetFile)}.${Date.now()}.bak`);
  fs.copyFileSync(targetFile, backupFile);
}

if (!fs.existsSync(targetFile)) {
  fs.writeFileSync(targetFile, `${block}\n`);
  process.exit(0);
}

const current = fs.readFileSync(targetFile, 'utf8');
if (current.includes(start) && current.includes(end)) {
  let updated = current.replace(
    new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`, 'm'),
    block,
  );
  const managedEnd = updated.indexOf(end) + end.length;
  const suffix = updated.slice(managedEnd);
  const trimmedSuffix = suffix.trimStart();
  if (trimmedSuffix === source || trimmedSuffix.startsWith(`${source}\n`)) {
    const preserved = trimmedSuffix.slice(source.length).trimStart();
    updated = `${updated.slice(0, managedEnd)}${preserved ? `\n\n${preserved}` : '\n'}`;
  }
  if (updated !== current) backupCurrent();
  fs.writeFileSync(targetFile, updated.endsWith('\n') ? updated : `${updated}\n`);
  process.exit(0);
}

if (current.trimEnd() === source) {
  fs.writeFileSync(targetFile, `${block}\n`);
  process.exit(0);
}

backupCurrent();
const merged = `${block}\n\n${current.trimStart()}`;
fs.writeFileSync(targetFile, merged.endsWith('\n') ? merged : `${merged}\n`);
EOF
}

sync_runtime_source_tree() {
  local runtime_root="$1"

  if [[ "$runtime_root" == "$repo_root" ]]; then
    return
  fi

  mkdir -p "$runtime_root/.codex"
  rm -rf "$runtime_root/skills" "$runtime_root/.codex/skills" "$runtime_root/.codex/hooks" "$runtime_root/tests"
  cp -R "$repo_root/skills" "$runtime_root/"
  ln -s ../skills "$runtime_root/.codex/skills"
  cp -R "$repo_root/.codex/hooks" "$runtime_root/.codex/"
}

install_skill_tree() {
  local skills_root="$1"
  local runtime_root="$2"

  mkdir -p "$skills_root"
  shopt -s nullglob
  for skill_dir in "$repo_root/skills"/*; do
    local skill_name
    skill_name="$(basename "$skill_dir")"
    rm -rf "$skills_root/$skill_name"
    cp -R "$skill_dir" "$skills_root/"
  done
  shopt -u nullglob
  render_runtime_root_in_tree "$skills_root" "$runtime_root"
}

install_legacy_codex_skill_links() {
  local canonical_skills_root="$1"
  local legacy_skills_root="$2"
  local backup_root="$codex_home/pickle-rick-backups/legacy-skills"

  mkdir -p "$legacy_skills_root"
  shopt -s nullglob
  for skill_dir in "$repo_root/skills"/*; do
    local skill_name
    local legacy_path
    local canonical_path
    skill_name="$(basename "$skill_dir")"
    legacy_path="$legacy_skills_root/$skill_name"
    canonical_path="$canonical_skills_root/$skill_name"
    if [[ -e "$legacy_path" || -L "$legacy_path" ]]; then
      if [[ -L "$legacy_path" && "$(canonicalize_path "$legacy_path")" == "$(canonicalize_path "$canonical_path")" ]]; then
        continue
      fi
      mkdir -p "$backup_root"
      mv "$legacy_path" "$backup_root/${skill_name}.$(date +%s).$$.bak"
    fi
    ln -s "$canonical_path" "$legacy_path"
  done
  shopt -u nullglob
}

render_runtime_root_in_tree() {
  local root_dir="$1"
  local runtime_root="$2"
  local exclude_names="${3:-}"

  node - "$root_dir" "$runtime_root" "$exclude_names" <<'EOF'
const fs = require('node:fs');
const path = require('node:path');

const [rootDir, runtimeRoot, excludeNamesRaw] = process.argv.slice(2);
const sourceRoots = [
  '$HOME/.codex/pickle-rick',
  '$HOME/.codex/pickle-rick/',
  '~/.codex/pickle-rick',
  '~/.codex/pickle-rick/',
];
const excludedNames = new Set(
  String(excludeNamesRaw || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const filePath = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      if (excludedNames.has(entry.name)) {
        continue;
      }
      walk(filePath);
      continue;
    }
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    let updated = content;
    for (const sourceRoot of sourceRoots) {
      if (!updated.includes(sourceRoot)) continue;
      const replacement = sourceRoot.endsWith('/') ? `${runtimeRoot}/` : runtimeRoot;
      updated = updated.split(sourceRoot).join(replacement);
    }
    if (updated === content) continue;
    try {
      fs.writeFileSync(filePath, updated);
    } catch {
      // Fail open for generated/runtime files we cannot rewrite safely.
    }
  }
}

if (fs.existsSync(rootDir)) {
  walk(rootDir);
}
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)
      project_dir="${2:-}"
      if [[ -z "$project_dir" ]]; then
        echo "Missing value for --project" >&2
        usage >&2
        exit 1
      fi
      shift 2
      ;;
    --enable-hooks)
      enable_hooks=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

repo_root="$(canonicalize_path "$repo_root")"
codex_home="$(canonicalize_path "$codex_home")"
agents_home="$(canonicalize_path "$agents_home")"
target_root="$(canonicalize_path "$target_root")"
assert_safe_install_roots

if [[ "$enable_hooks" -eq 1 ]]; then
  echo "--enable-hooks is unsupported until Codex hook delivery and decision schemas pass authenticated validation." >&2
  exit 1
fi

if [[ "$repo_root" == "$target_root" ]]; then
  runtime_is_installed_source=1
fi

if [[ -d "$repo_root/.git" ]]; then
  repo_is_checkout=1
fi

if [[ -n "$project_dir" ]]; then
  project_dir="$(cd "$project_dir" && pwd -P)"
  if [[ "$project_dir" == "$repo_root" ]]; then
    project_is_source=1
  fi
fi

# --- BUILD (source-checkout mode only) ---
# Compile the TypeScript runtime before deploy. The installed runtime copy has no
# src/tsconfig/node_modules (the deploy rsync excludes them), so it cannot and must
# not rebuild — it deploys its already-compiled extension/ as-is. Set
# PICKLE_INSTALL_SKIP_BUILD=1 to deploy a pre-built tree without recompiling.
if [[ "$runtime_is_installed_source" -eq 0 && "${PICKLE_INSTALL_SKIP_BUILD:-0}" != "1" && -d "$repo_root/extension/src" ]]; then
  echo "Building Pickle Rick Codex runtime (extension/)..."
  ( cd "$repo_root/extension" && npm ci --no-fund --no-audit )
  # Force-clean stale compiled twins so a stale tsc cache can never be deployed.
  rm -rf "$repo_root/extension/bin" "$repo_root/extension/services" "$repo_root/extension/types"
  rm -f "$repo_root/extension/.tsbuildinfo"
  ( cd "$repo_root/extension" && npx tsc )
  # tsc does not emit .sh; stage shell assets from src/scripts/ into the compiled bin/.
  bash "$repo_root/extension/scripts/copy-shell-assets.sh"
fi

mkdir -p "$target_root"
mkdir -p "$codex_home"
mkdir -p "$agents_home"

copy_item() {
  local item="$1"
  if [[ -e "$repo_root/$item" ]]; then
    cp -R "$repo_root/$item" "$target_root/"
  fi
}

if [[ "$runtime_is_installed_source" -eq 0 ]]; then
  rm -rf "$target_root/bin" "$target_root/lib" "$target_root/docs" "$target_root/.codex-plugin"
  rm -f "$target_root/CLAUDE.md"
  copy_item README.md
  copy_item AGENTS.md
  copy_item package.json
  copy_item prd.md
  copy_item install.sh
  copy_item .codex-plugin
  copy_item docs
  copy_item images
  # Deploy the compiled TypeScript runtime, source-level invariant fixtures, and
  # tests while excluding development dependencies and build configuration.
  # Tests stay beside the compiled files they import; source is retained because
  # several architecture tests inspect it. Conditional pretest skips compilation
  # when the installed package has no node_modules.
  # $target_root/extension/. --delete-excluded keeps the deployed tree clean and
  # idempotent across reinstalls.
  mkdir -p "$target_root/extension"
  rsync -a --delete --delete-excluded \
    --exclude='node_modules' \
    --exclude='tsconfig.json' \
    "$repo_root/extension/" "$target_root/extension/"
fi
sync_runtime_source_tree "$target_root"
touch "$target_root/.pickle-rick-runtime"
if [[ "$runtime_is_installed_source" -eq 0 || "$repo_is_checkout" -eq 0 ]]; then
  render_runtime_root_in_tree "$target_root" "$target_root" "sessions,activity"
fi

install_skill_tree "$agents_home/skills" "$target_root"
install_legacy_codex_skill_links "$agents_home/skills" "$codex_home/skills"
merge_managed_markdown "$target_root/AGENTS.md" "$codex_home/AGENTS.md" "agents" "$codex_home/pickle-rick-backups"

if [[ -n "$project_dir" && "$project_is_source" -eq 0 ]]; then
  install_skill_tree "$project_dir/.agents/skills" "$target_root"
  merge_managed_markdown "$target_root/AGENTS.md" "$project_dir/AGENTS.md" "agents" "$project_dir/.codex/pickle-rick-backups"
fi

echo "Installed Pickle Rick Codex runtime to:"
echo "  $target_root"
echo "Installed Pickle Rick persona and skills into:"
echo "  persona: $codex_home/AGENTS.md"
echo "  skills: $agents_home/skills"
if [[ -n "$project_dir" ]]; then
  if [[ "$project_is_source" -eq 1 ]]; then
    echo "Project bootstrap skipped because the target project is the source repo:"
    echo "  $project_dir"
    echo
    echo "Persona activation:"
    echo "  Pickle Rick is already installed globally for Codex"
    echo "  the source repo already contains matching local persona files"
  else
    echo "Copied project-facing Pickle Rick assets to:"
    echo "  $project_dir"
    echo
    echo "Project override activation:"
    echo "  open the project in Codex so it can prefer $project_dir/AGENTS.md"
    echo "  global Pickle Rick install remains available in every workspace"
    echo "  project-local hooks were left untouched; hook installation is disabled pending authenticated validation"
  fi
fi
echo
echo "Global usage:"
echo "  open any project in Codex and invoke the Pickle Rick skills"
echo "  project bootstrap is optional and only needed for repo-local overrides"
echo
echo "Guaranteed path:"
echo "  node $target_root/extension/bin/setup.js \"<task>\""
echo "  node $target_root/extension/bin/draft-prd.js <session-dir> \"<task>\""
echo "  node $target_root/extension/bin/spawn-refinement-team.js <session-dir>"
echo "  node $target_root/extension/bin/mux-runner.js <session-dir>"
