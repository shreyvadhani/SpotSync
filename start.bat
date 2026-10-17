@echo off
echo ========================================================
echo        SpotSync - Real-Time Parking System v1.1         
echo ========================================================
echo.
echo Opening SpotSync in your web browser...
start http://localhost:8000/
echo Starting SpotSync Backend Server...
cd backend
python app.py
pause
