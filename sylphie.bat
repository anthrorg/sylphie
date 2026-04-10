@echo off
title Sylphie Launcher
cd /d "C:\Users\Jim\OneDrive\Desktop\Code\sylphie"

echo ========================================
echo  Sylphie Launcher
echo ========================================
echo.

:: Check Docker is running
docker info >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Docker is not running. Start Docker Desktop first.
    pause
    exit /b 1
)

:: Start all containers (databases + perception service)
echo [1/3] Checking Docker containers...
docker compose ps --format "{{.Name}}" 2>nul | findstr "sylphie-" >nul
if errorlevel 1 (
    echo       Building perception service...
    docker compose build perception >nul 2>&1
    echo       Starting containers...
    docker compose up -d
) else (
    echo       Containers already running.
)
echo.

:: Wait for containers to be healthy
echo [2/3] Waiting for services...
:wait_loop
set healthy=0
for /f %%i in ('docker compose ps --format "{{.Status}}" 2^>nul ^| findstr /c:"healthy" ^| find /c /v ""') do set healthy=%%i
for /f %%i in ('docker compose ps --format "{{.Name}}" 2^>nul ^| find /c /v ""') do set total=%%i
if %healthy% LSS %total% (
    echo       %healthy%/%total% healthy...
    timeout /t 2 /nobreak >nul
    goto wait_loop
)
echo       All %total% containers healthy.
echo.

:: Build shared package and generate Prisma client
echo [3/6] Building shared package...
call yarn prisma:generate
call yarn build:shared

:: Launch cognition service (TensorFlow pipeline)
echo [4/6] Launching Cognition Service...
:: Kill any stale process on port 8431
for /f "tokens=5" %%a in ('netstat -ano ^| findstr "8431.*LISTEN"') do (
    taskkill /F /PID %%a >nul 2>&1
)
:: Set up venv if it exists, otherwise use global Python
if exist "packages\cognition-service\.venv\Scripts\activate.bat" (
    start "Cognition Service" cmd /k "cd /d C:\Users\Jim\OneDrive\Desktop\Code\sylphie\packages\cognition-service && .venv\Scripts\activate && python -m uvicorn main:app --host 127.0.0.1 --port 8431"
) else (
    start "Cognition Service" cmd /k "cd /d C:\Users\Jim\OneDrive\Desktop\Code\sylphie\packages\cognition-service && python -m uvicorn main:app --host 127.0.0.1 --port 8431"
)
timeout /t 3 /nobreak >nul

:: Launch drive server
echo [5/6] Launching Drive Engine server...
start "Drive Server" cmd /k "cd /d C:\Users\Jim\OneDrive\Desktop\Code\sylphie && yarn dev:drive-server"
timeout /t 2 /nobreak >nul

echo [6/6] Launching Frontend and Backend...
start "Sylphie Frontend" cmd /k "cd /d C:\Users\Jim\OneDrive\Desktop\Code\sylphie && yarn dev"
start "Sylphie Backend" cmd /k "cd /d C:\Users\Jim\OneDrive\Desktop\Code\sylphie && yarn dev:backend"

echo.
echo ========================================
echo  Frontend:     http://localhost:5173
echo  Backend:      http://localhost:3000
echo  Drive Server: ws://localhost:3001
echo  Cognition:    http://localhost:8431
echo  Perception:   http://localhost:8430
echo  SearXNG:      http://localhost:8888
echo ========================================
echo.
echo Close this window anytime. Services run
echo in their own terminals.
echo.
pause
