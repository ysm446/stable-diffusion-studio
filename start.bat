@echo off
setlocal EnableExtensions EnableDelayedExpansion
echo ========================================
echo  Stable Diffusion Studio
echo ========================================
echo.

REM Check Node.js
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found.
    echo Please install Node.js from https://nodejs.org/
    echo.
    pause
    exit /b 1
)

set "ROOT_DIR=%~dp0"
set "APP_VENV_DIR=%ROOT_DIR%.venv"
set "APP_VENV_PYTHON=%APP_VENV_DIR%\Scripts\python.exe"
set "APP_VENV_ACTIVATE=%APP_VENV_DIR%\Scripts\activate.bat"
set "DEPS_MARKER=%APP_VENV_DIR%\.deps-installed"
set "PYTHON_CMD="

REM Create and activate project venv
if not exist "%APP_VENV_PYTHON%" (
    echo Creating Python venv...
    where py >nul 2>&1
    if not errorlevel 1 set "PYTHON_CMD=py -3"

    if not defined PYTHON_CMD (
        where python >nul 2>&1
        if not errorlevel 1 set "PYTHON_CMD=python"
    )

    if not defined PYTHON_CMD (
        echo [ERROR] Python not found.
        echo Please install Python 3.10 or later and add it to PATH.
        echo.
        pause
        exit /b 1
    )

    !PYTHON_CMD! -m venv "%APP_VENV_DIR%"
    if errorlevel 1 (
        echo [ERROR] Failed to create Python venv.
        pause
        exit /b 1
    )
)

call "%APP_VENV_ACTIVATE%"
if errorlevel 1 (
    echo [ERROR] Failed to activate Python venv.
    pause
    exit /b 1
)

python -c "import pynvml" >nul 2>&1
if errorlevel 1 (
    if exist "%DEPS_MARKER%" del /q "%DEPS_MARKER%"
)

if not exist "%DEPS_MARKER%" (
    echo Installing Python dependencies...
    python -m pip install -r "%ROOT_DIR%requirements.txt"
    if errorlevel 1 (
        echo [ERROR] Failed to install Python dependencies.
        pause
        exit /b 1
    )
    echo ok>"%DEPS_MARKER%"
)

REM Set HF_HOME
set "HF_HOME=%ROOT_DIR%models"

REM Disable Hugging Face Hub telemetry (agent detection cache etc.)
set "HF_HUB_DISABLE_TELEMETRY=1"

REM Start Python server in background
echo Starting Python server...
cd /d "%ROOT_DIR%"
start /B python -m server.main --port 8785

REM Start Electron
cd /d "%ROOT_DIR%electron"

if not exist "node_modules" (
    echo [First run] Running npm install...
    npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
    echo.
)

echo Starting Electron...
npm start

pause
