@echo off
rem ============================================================
rem  一键自测：跑全部自动化测试并汇总到 artifacts\results\SUMMARY.md
rem  用法：
rem    run_all.cmd            全部（含约 10 分钟长跑）
rem    run_all.cmd --quick    跳过长时间运行
rem ============================================================
setlocal
cd /d "%~dp0.."
title 武士零 - 丐版 - 自测
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 需要 Node.js 18+ 才能跑自测。
  pause
  exit /b 1
)
node tests\run_all.mjs %*
set EXITCODE=%errorlevel%
echo.
echo 自测结束，汇总见 artifacts\results\SUMMARY.md
if not "%EXITCODE%"=="0" echo 有测试未通过（exit=%EXITCODE%）
pause
exit /b %EXITCODE%
