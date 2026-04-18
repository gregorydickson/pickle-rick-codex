#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
codex_home="${CODEX_HOME:-$HOME/.codex}"
target_root="${PICKLE_DATA_ROOT:-$codex_home/pickle-rick}"
project_dir=""
enable_hooks=0
project_is_source=0
runtime_is_installed_source=0
repo_is_checkout=0

usage() {
  cat <<'EOF'
Usage:
  bash install.sh
  bash install.sh --project /path/to/project
  bash install.sh --project /path/to/project --enable-hooks
EOF
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

if (!fs.existsSync(targetFile)) {
  fs.writeFileSync(targetFile, `${block}\n`);
  process.exit(0);
}

const current = fs.readFileSync(targetFile, 'utf8');
if (current.includes(start) && current.includes(end)) {
  const updated = current.replace(
    new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`, 'm'),
    block,
  );
  fs.writeFileSync(targetFile, updated.endsWith('\n') ? updated : `${updated}\n`);
  process.exit(0);
}

if (current.trimEnd() === source) {
  fs.writeFileSync(targetFile, `${block}\n`);
  process.exit(0);
}

fs.mkdirSync(backupDir, { recursive: true });
const backupFile = path.join(backupDir, `${path.basename(targetFile)}.${Date.now()}.bak`);
fs.copyFileSync(targetFile, backupFile);
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
  rm -rf "$runtime_root/.codex/skills" "$runtime_root/.codex/hooks" "$runtime_root/tests"
  cp -R "$repo_root/.codex/skills" "$runtime_root/.codex/"
  cp -R "$repo_root/.codex/hooks" "$runtime_root/.codex/"
  cp -R "$repo_root/tests" "$runtime_root/"
}

install_skill_tree() {
  local skills_root="$1"
  local runtime_root="$2"

  mkdir -p "$skills_root"
  shopt -s nullglob
  for skill_dir in "$repo_root/.codex/skills"/*; do
    local skill_name
    skill_name="$(basename "$skill_dir")"
    rm -rf "$skills_root/$skill_name"
    cp -R "$skill_dir" "$skills_root/"
  done
  shopt -u nullglob
  render_runtime_root_in_tree "$skills_root" "$runtime_root"
}

render_runtime_root_in_tree() {
  local root_dir="$1"
  local runtime_root="$2"

  node - "$root_dir" "$runtime_root" <<'EOF'
const fs = require('node:fs');
const path = require('node:path');

const [rootDir, runtimeRoot] = process.argv.slice(2);
const sourceRoots = [
  '$HOME/.codex/pickle-rick',
  '$HOME/.codex/pickle-rick/',
  '~/.codex/pickle-rick',
  '~/.codex/pickle-rick/',
];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(filePath);
      continue;
    }
    const content = fs.readFileSync(filePath, 'utf8');
    let updated = content;
    for (const sourceRoot of sourceRoots) {
      if (!updated.includes(sourceRoot)) continue;
      const replacement = sourceRoot.endsWith('/') ? `${runtimeRoot}/` : runtimeRoot;
      updated = updated.split(sourceRoot).join(replacement);
    }
    if (updated === content) continue;
    fs.writeFileSync(filePath, updated);
  }
}

if (fs.existsSync(rootDir)) {
  walk(rootDir);
}
EOF
}

install_project_hooks() {
  local hooks_dir="$1"
  local runtime_root="$2"
  local template_file="$3"

  mkdir -p "$hooks_dir"
  if [[ -f "$hooks_dir/hooks.json" ]]; then
    local backup_dir="$hooks_dir/pickle-rick-backups"
    mkdir -p "$backup_dir"
    cp "$hooks_dir/hooks.json" "$(backup_path "$hooks_dir/hooks.json" "$backup_dir")"
  fi
  cp "$template_file" "$hooks_dir/hooks.json"
  render_runtime_root_in_tree "$hooks_dir" "$runtime_root"
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

mkdir -p "$target_root"
mkdir -p "$codex_home"

copy_item() {
  local item="$1"
  if [[ -e "$repo_root/$item" ]]; then
    cp -R "$repo_root/$item" "$target_root/"
  fi
}

if [[ "$runtime_is_installed_source" -eq 0 ]]; then
  rm -rf "$target_root/bin" "$target_root/lib" "$target_root/docs" "$target_root/.codex-plugin"
  copy_item README.md
  copy_item AGENTS.md
  copy_item CLAUDE.md
  copy_item package.json
  copy_item prd.md
  copy_item install.sh
  copy_item .codex-plugin
  copy_item docs
  copy_item images
  copy_item bin
  copy_item lib
fi
sync_runtime_source_tree "$target_root"
if [[ "$runtime_is_installed_source" -eq 0 || "$repo_is_checkout" -eq 0 ]]; then
  render_runtime_root_in_tree "$target_root" "$target_root"
fi

install_skill_tree "$codex_home/skills" "$target_root"
merge_managed_markdown "$target_root/AGENTS.md" "$codex_home/AGENTS.md" "agents" "$codex_home/pickle-rick-backups"
merge_managed_markdown "$target_root/CLAUDE.md" "$codex_home/CLAUDE.md" "claude" "$codex_home/pickle-rick-backups"

if [[ -n "$project_dir" && "$project_is_source" -eq 0 ]]; then
  install_skill_tree "$project_dir/.codex/skills" "$target_root"
  merge_managed_markdown "$target_root/AGENTS.md" "$project_dir/AGENTS.md" "agents" "$project_dir/.codex/pickle-rick-backups"
  merge_managed_markdown "$target_root/CLAUDE.md" "$project_dir/CLAUDE.md" "claude" "$project_dir/.codex/pickle-rick-backups"
  if [[ "$enable_hooks" -eq 1 ]]; then
    install_project_hooks "$project_dir/.codex/hooks" "$target_root" "$repo_root/.codex/hooks/hooks.template.json"
  fi
fi

echo "Installed Pickle Rick Codex runtime to:"
echo "  $target_root"
echo "Installed Pickle Rick persona and skills into:"
echo "  $codex_home"
if [[ -n "$project_dir" ]]; then
  if [[ "$project_is_source" -eq 1 ]]; then
    echo "Project bootstrap skipped because the target project is the source repo:"
    echo "  $project_dir"
    echo
    echo "Persona activation:"
    echo "  Pickle Rick is already installed globally for Codex"
    echo "  the source repo already contains matching local persona files"
  else
    echo "Copied project-facing .codex assets to:"
    echo "  $project_dir"
    echo
    echo "Project override activation:"
    echo "  open the project in Codex so it can prefer $project_dir/AGENTS.md"
    echo "  global Pickle Rick install remains available in every workspace"
    if [[ "$enable_hooks" -eq 1 ]]; then
      echo "  project-local hooks were installed from a rendered template"
    else
      echo "  project-local hooks were left untouched; pass --enable-hooks to install experimental hooks"
    fi
  fi
fi
echo
echo "Global usage:"
echo "  open any project in Codex and invoke the Pickle Rick skills"
echo "  project bootstrap is optional and only needed for repo-local overrides"
echo
echo "Guaranteed path:"
echo "  node $target_root/bin/setup.js \"<task>\""
echo "  node $target_root/bin/draft-prd.js <session-dir> \"<task>\""
echo "  node $target_root/bin/spawn-refinement-team.js <session-dir>"
echo "  node $target_root/bin/mux-runner.js <session-dir>"
