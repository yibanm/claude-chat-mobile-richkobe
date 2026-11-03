@echo off
rem win-run.cmd - crash-resilient wrapper for the CCM server (used by the
rem Startup-folder bootstrap and the desktop entry).
rem
rem WHY A WRAPPER: the Startup entry only launches once at logon; if the server
rem dies (bad config edit, port clash, node crash) nobody is at the desk to
rem restart it and the phone silently loses its backend. This loop turns
rem "died" into "back in 10s".
rem
rem WHY 10s AND NOT IMMEDIATE: a config error makes the server exit at startup;
rem an instant retry would spin once per second and flood the log. At 10s the
rem log stays readable and there is a window to fix the config.
rem
rem CONCURRENCY GUARD: if something already listens on 3000, exit at once.
rem Without it a manual double-click plus the logon entry would each start a
rem copy; the second dies on EADDRINUSE every 10s and floods the log while the
rem symptom (phone cannot connect) looks exactly like "server never started".
rem
rem *** THIS FILE MUST STAY PURE ASCII ***
rem cmd.exe parses .cmd/.bat as ANSI (GBK on zh-CN Windows). UTF-8 Chinese bytes
rem decode into garbage that swallows the rem marker, so a comment line gets
rem EXECUTED as a command. Observed 2026-11-02: three rem lines with Chinese
rem text ran as commands and aborted the script. English-only from here on.

cd /d "%~dp0.."

netstat -ano | findstr ":3000 " | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo [%date% %time%] port 3000 already listening; another instance runs; exit >> "%~dp0..\data\win-server.log"
  exit /b 0
)

if not exist "%~dp0..\data" mkdir "%~dp0..\data"
set "LOG=%~dp0..\data\win-server.log"

:loop
where node >nul 2>nul
if errorlevel 1 (
  set "NODE=C:\Program Files\nodejs\node.exe"
) else (
  set "NODE=node"
)
"%NODE%" app/server.js >> "%LOG%" 2>&1
echo [%date% %time%] server exited (code %errorlevel%), restart in 10s >> "%LOG%"
timeout /t 10 /nobreak >nul
goto loop
