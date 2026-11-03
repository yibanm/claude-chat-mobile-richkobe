@echo off
rem uninstall-ccm.cmd - symmetric teardown of the Windows resident setup.
rem Removes the logon autostart bootstrap and the desktop entry only.
rem Project files and data/ (sessions, config) are untouched.
rem
rem *** KEEP THIS FILE PURE ASCII *** (cmd parses .cmd as ANSI/GBK on zh-CN
rem Windows; UTF-8 Chinese in comments gets executed as commands.)
rem The desktop folder is resolved at runtime because on this machine it is
rem redirected off %USERPROFILE% (D:\Desktop), and a hardcoded non-ASCII path
rem would violate the ASCII rule above.
set "SU=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
del /q "%SU%\CCM-Server.cmd" 2>nul
for /f "delims=" %%i in ('powershell -NoProfile -Command "[Environment]::GetFolderPath('Desktop')"') do set "DESK=%%i"
if defined DESK del /q "%DESK%\start-ccm.cmd" 2>nul
echo Removed CCM logon autostart and desktop entry. Project files and data/ untouched.
pause
