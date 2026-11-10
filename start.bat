@echo off
setlocal
title AI Canvas
cd /d "%~dp0"

echo.
echo   AI Canvas
echo   ----------------------------------------
echo.

where node >nul 2>nul
if errorlevel 1 goto nonode

echo   Starting server.js ...
echo.
node server.js
echo.
echo   Server stopped.
echo.
pause
exit /b 0

:nonode
echo   [ERROR] Node.js not found in PATH.
echo.
echo   Install Node.js 18 or newer from https://nodejs.org
echo   Then run this file again.
echo.
echo   Diagnostic info:
echo     current dir : %CD%
echo.
pause
exit /b 1
