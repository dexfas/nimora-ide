#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "[shuncode] Preparing source development environment..."

if ! npm ls @modelcontextprotocol/sdk@1.30.0 @vscode/ripgrep@1.17.1 --depth=0 >/dev/null 2>&1; then
	if ! node -e "const fs=require('node:fs');const r=fs.readFileSync('.nvmrc','utf8').trim().split('.').map(Number),c=process.versions.node.split('.').map(Number);process.exit(c[0]===r[0]&&(c[1]>r[1]||(c[1]===r[1]&&c[2]>=r[2]))?0:1)"; then
		echo "[shuncode] Node.js 24.18.0 or newer in the Node 24 line is required for npm ci. Current: $(node --version)" >&2
		exit 1
	fi
	echo "[shuncode] Root dependencies are missing or stale. Running npm ci..."
	npm ci
fi

if [[ ! -f extensions/node_modules/esbuild/package.json ]]; then
	echo "[shuncode] Shared extension dependencies are missing. Installing them..."
	npm --prefix extensions ci
fi

if ! node -e "const fs=require('node:fs'); const {rgPath}=require('@vscode/ripgrep'); process.exit(fs.existsSync(rgPath)?0:1)"; then
	echo "[shuncode] Ripgrep binary is missing. Rebuilding @vscode/ripgrep..."
	npm rebuild @vscode/ripgrep
fi

if [[ ! -f node_modules/@vscode/policy-watcher/build/Release/vscode-policy-watcher.node ]]; then
	echo "[shuncode] Electron native bindings are missing. Rebuilding direct native dependencies..."
	npm run rebuild-shuncode-native
fi

npm run typecheck-shuncode
npm run compile-shuncode

export SHUNCODE_AGENT_HOST_ENTRY="$ROOT/extensions/shuncode/runtime/agent-host.js"
export SHUNCODE_SKIP_CORE_TYPECHECK=1
SHUNCODE_DEV_USER_DATA="$ROOT/.build/shuncode-dev-user-data"
SHUNCODE_DEV_EXTENSIONS="$ROOT/.build/shuncode-dev-extensions"
SHUNCODE_DEV_SHARED_DATA="$ROOT/.build/shuncode-dev-shared-data"

# A source launcher may itself run inside an installed VS Code/ShunCode
# extension host. Do not pass the host Electron/IPC identity to the new app.
unset ELECTRON_RUN_AS_NODE
unset VSCODE_CODE_CACHE_PATH
unset VSCODE_CRASH_REPORTER_PROCESS_TYPE
unset VSCODE_CWD
unset VSCODE_ESM_ENTRYPOINT
unset VSCODE_HANDLES_UNCAUGHT_ERRORS
unset VSCODE_IPC_HOOK
unset VSCODE_L10N_BUNDLE_LOCATION
unset VSCODE_NLS_CONFIG
unset VSCODE_PID

if [[ "${1:-}" == "--prepare-only" ]]; then
	echo "[shuncode] Preparing the Code-OSS desktop runtime..."
	node build/lib/preLaunch.ts
	echo "[shuncode] Source development environment is ready."
	exit 0
fi

echo "[shuncode] Launching ShunCode from source..."
exec "$ROOT/scripts/code.sh" --user-data-dir "$SHUNCODE_DEV_USER_DATA" --extensions-dir "$SHUNCODE_DEV_EXTENSIONS" --shared-data-dir "$SHUNCODE_DEV_SHARED_DATA" "$@"
