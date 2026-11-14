@echo off
rem Starts the website on http://127.0.0.1:5173
rem (works even where "npm run dev" fails because of a broken ComSpec variable)
cd /d "%~dp0web"
set "ComSpec=%SystemRoot%\System32\cmd.exe"
if not exist node_modules call npm install
node node_modules\vite\bin\vite.js --open
