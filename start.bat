@echo off
echo ========================================================
echo        SpotSync - Real-Time Parking System v1.1
echo ========================================================
echo.
cd /d "%~dp0backend"

echo Checking Python dependencies...
python -m pip install -q -r requirements.txt
if errorlevel 1 (
  echo Failed to install dependencies. Make sure Python 3.10+ and pip are installed.
  pause
  exit /b 1
)

echo Opening SpotSync in your web browser in 3 seconds...
start "" cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:8000/"

echo Starting SpotSync server on http://localhost:8000 ...
python app.py
pause
