@echo off
setlocal
if exist "%~dp0dist\desktop\win-unpacked\IDO Agent.exe" (
    start "" "%~dp0dist\desktop\win-unpacked\IDO Agent.exe"
    exit /b 0
)
if exist "%APPDATA%\Microsoft\Windows\Start Menu\Programs\IDO Agent.lnk" (
    start "" "%APPDATA%\Microsoft\Windows\Start Menu\Programs\IDO Agent.lnk"
    exit /b 0
)
echo IDO Agent is not installed or built yet.
echo Install the IDO Agent installer supplied by your organizer, then open IDO Agent from Start.
echo Developers: run npm ci and npm run agent:desktop:package in this Windows checkout.
echo See docs\discord-agent-participant.md and docs\agent-desktop-development.md.
pause
exit /b 1
