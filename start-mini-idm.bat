@echo off
title Mini-IDM Companion Server (127.0.0.1:10010)
cd /d "%~dp0"
echo Verification du port 10010...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":10010" ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)
echo Demarrage du serveur local Mini-IDM...
start "" "http://127.0.0.1:10010"
node server\server.js
pause
