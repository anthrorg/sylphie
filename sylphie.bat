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
echo [3/4] Building shared package...
call yarn prisma:generate
call yarn build:shared

:: Launch drive server, frontend, and backend
echo [4/5] Launching Drive Engine server...
start "Drive Server" cmd /k "cd /d C:\Users\Jim\OneDrive\Desktop\Code\sylphie && yarn dev:drive-server"
timeout /t 2 /nobreak >nul

echo [5/5] Launching Frontend and Backend...
start "Sylphie Frontend" cmd /k "cd /d C:\Users\Jim\OneDrive\Desktop\Code\sylphie && yarn dev"
start "Sylphie Backend" cmd /k "cd /d C:\Users\Jim\OneDrive\Desktop\Code\sylphie && yarn dev:backend"

echo.
echo ========================================
echo  Frontend:     http://localhost:5173
echo  Backend:      http://localhost:3000
echo  Drive Server: ws://localhost:3001
echo  Perception:   http://localhost:8430
echo  SearXNG:      http://localhost:8888
echo ========================================
echo.
echo Close this window anytime. Services run
echo in their own terminals.
echo.
pause
