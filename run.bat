@echo off
REM Optional local server. Not required (file:// works), but handy.
cd /d "%~dp0"
echo Serving CAN Trace Viewer on http://localhost:8080/index.html
start "" http://localhost:8080/index.html
python -m http.server 8080
