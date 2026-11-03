@echo off
rem start-ccm.cmd - manual / desktop entry: run the CCM server in a minimized
rem background window. Logon autostart (Startup folder) uses the same wrapper;
rem the port guard inside scripts\win-run.cmd stops a second copy from starting.
rem
rem *** KEEP THIS FILE PURE ASCII ***
rem cmd.exe parses .cmd content as ANSI (GBK on zh-CN Windows). UTF-8 Chinese
rem bytes decode into garbage that swallows the rem marker, so comment lines
rem get EXECUTED as commands and abort the script (observed 2026-11-02).
title CCM Server
start "CCM Server" /min cmd /c "%~dp0scripts\win-run.cmd"
exit /b 0
