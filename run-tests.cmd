@echo off
setlocal
cd /d "%~dp0UC4_Automation_Suite - share"
npx playwright test tests/FullSuiteRun.spec.js --config=playwright.config.js %*
