@echo off
rem ============================================================
rem  Samurai Zero - Launcher
rem  Double-click this file to start the game.
rem  1) starts a tiny local static server (127.0.0.1, auto port)
rem  2) opens your default browser at the game
rem  No installation, no global config, no admin rights needed.
rem
rem  NOTE: this file is intentionally ASCII-only, because cmd.exe
rem  parses .cmd files using the system code page (GBK on zh-CN),
rem  and UTF-8 Chinese text would break the batch parser.
rem ============================================================
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Samurai Zero - Gaiban

where node >nul 2>nul
if errorlevel 1 goto :no_node

echo Starting local server, the browser will open automatically...
node server.mjs
if errorlevel 1 goto :failed
goto :eof

:no_node
echo.
echo [ERROR] Node.js not found.
echo         This game needs a Node.js runtime (only to serve local files).
echo         Install Node.js 18+ from https://nodejs.org/ and try again.
echo.
pause
exit /b 1

:failed
echo.
echo [ERROR] The server failed to start. Please copy the messages above
echo         and report them.
echo.
pause
exit /b 1
