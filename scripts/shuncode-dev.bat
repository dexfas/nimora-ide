@echo off
setlocal EnableExtensions

pushd "%~dp0\.."
if errorlevel 1 exit /b 1

echo [shuncode] Preparing source development environment...

call npm ls @modelcontextprotocol/sdk@1.30.0 @vscode/ripgrep@1.17.1 --depth=0 >nul 2>&1
if errorlevel 1 (
	node -e "const fs=require('node:fs');const r=fs.readFileSync('.nvmrc','utf8').trim().split('.').map(Number),c=process.versions.node.split('.').map(Number);process.exit(c[0]===r[0]&&(c[1]>r[1]||(c[1]===r[1]&&c[2]>=r[2]))?0:1)"
	if errorlevel 1 (
		echo [shuncode] Node.js 24.18.0 or newer in the Node 24 line is required for npm ci. Current: & node --version
		goto fail
	)
	echo [shuncode] Root dependencies are missing or stale. Running npm ci...
	call npm ci
	if errorlevel 1 goto fail
)

if not exist "extensions\node_modules\esbuild\package.json" (
	echo [shuncode] Shared extension dependencies are missing. Installing them...
	call npm --prefix extensions ci
	if errorlevel 1 goto fail
)

node -e "const fs=require('node:fs'); const {rgPath}=require('@vscode/ripgrep'); process.exit(fs.existsSync(rgPath)?0:1)" >nul 2>&1
if errorlevel 1 (
	echo [shuncode] Ripgrep binary is missing. Rebuilding @vscode/ripgrep...
	call npm rebuild @vscode/ripgrep
	if errorlevel 1 goto fail
)

if not exist "node_modules\@vscode\policy-watcher\build\Release\vscode-policy-watcher.node" (
	echo [shuncode] Electron native bindings are missing. Rebuilding direct native dependencies...
	call npm run rebuild-shuncode-native
	if errorlevel 1 goto fail
)

call npm run typecheck-shuncode
if errorlevel 1 goto fail

call npm run compile-shuncode
if errorlevel 1 goto fail

set "SHUNCODE_AGENT_HOST_ENTRY=%CD%\extensions\shuncode\runtime\agent-host.js"
set "SHUNCODE_SKIP_CORE_TYPECHECK=1"
set "SHUNCODE_DEV_USER_DATA=%CD%\.build\shuncode-dev-user-data"
set "SHUNCODE_DEV_EXTENSIONS=%CD%\.build\shuncode-dev-extensions"
set "SHUNCODE_DEV_SHARED_DATA=%CD%\.build\shuncode-dev-shared-data"

rem This script is often launched from the installed ShunCode extension host,
rem which exports Electron/VS Code process variables that must not leak into a
rem second desktop process. Keep the source instance independent from the host.
set "ELECTRON_RUN_AS_NODE="
set "VSCODE_CODE_CACHE_PATH="
set "VSCODE_CRASH_REPORTER_PROCESS_TYPE="
set "VSCODE_CWD="
set "VSCODE_ESM_ENTRYPOINT="
set "VSCODE_HANDLES_UNCAUGHT_ERRORS="
set "VSCODE_IPC_HOOK="
set "VSCODE_L10N_BUNDLE_LOCATION="
set "VSCODE_NLS_CONFIG="
set "VSCODE_PID="

if /I "%~1"=="--prepare-only" (
	echo [shuncode] Preparing the Code-OSS desktop runtime...
	node build/lib/preLaunch.ts
	if errorlevel 1 goto fail
	echo [shuncode] Source development environment is ready.
	popd
	exit /b 0
)

echo [shuncode] Launching ShunCode from source...
call "%~dp0code.bat" --user-data-dir "%SHUNCODE_DEV_USER_DATA%" --extensions-dir "%SHUNCODE_DEV_EXTENSIONS%" --shared-data-dir "%SHUNCODE_DEV_SHARED_DATA%" %*
set "EXIT_CODE=%ERRORLEVEL%"
popd
exit /b %EXIT_CODE%

:fail
set "EXIT_CODE=%ERRORLEVEL%"
if "%EXIT_CODE%"=="0" set "EXIT_CODE=1"
echo [shuncode] Development preparation failed with exit code %EXIT_CODE%. 1>&2
popd
exit /b %EXIT_CODE%
