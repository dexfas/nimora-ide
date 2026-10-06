@echo off
setlocal
rem Keep Nimora's data separate from the installed ShunCode distribution.
set "ELECTRON_RUN_AS_NODE="
start "" "%~dp0ShunCode.exe" --user-data-dir "%LOCALAPPDATA%\Nimora\UserData" --extensions-dir "%LOCALAPPDATA%\Nimora\Extensions" --shared-data-dir "%LOCALAPPDATA%\Nimora\SharedData" %*
endlocal
