@echo off
rem Launches VoiceB without a terminal hanging around.
rem
rem ELECTRON_RUN_AS_NODE is cleared deliberately: editors and agent tooling
rem export it, and inherited into our launch it makes electron.exe behave like
rem plain Node — no window, just a confusing crash.

set "ELECTRON_RUN_AS_NODE="
set "ROOT=%~dp0"
set "ELECTRON=%ROOT%node_modules\electron\dist\electron.exe"

if not exist "%ELECTRON%" (
  echo Electron is not installed. Run "npm install" in %ROOT% first.
  pause
  exit /b 1
)

start "" "%ELECTRON%" "%ROOT%."
