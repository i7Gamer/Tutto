@echo off
setlocal

echo =====================================
echo Installing dependencies...
echo =====================================
call npm install

if %errorlevel% neq 0 (
    echo npm install failed.
    pause
    exit /b %errorlevel%
)

echo =====================================
echo Building application...
echo =====================================
call npm run build

if %errorlevel% neq 0 (
    echo npm run build failed.
    pause
    exit /b %errorlevel%
)

echo =====================================
echo Starting services...
echo =====================================
call npm run start

if %errorlevel% neq 0 (
    echo npm run start failed.
    pause
    exit /b %errorlevel%
)

echo =====================================
echo All services started.
echo =====================================

exit /b 0