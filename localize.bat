@echo off
chcp 65001 >nul
title OpenMausBot Localization
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Python not found. Install Python 3.8+ and check PATH.
    pause
    exit /b 1
)

if /i "%~1"=="restore" goto restore
if /i "%~1"=="list" goto list
if not "%~1"=="" goto run

:menu
echo.
echo  ============================================
echo    OpenMausBot Localization
echo  ============================================
echo    [1] Localize  - translate UI (pick language)
echo    [2] Restore   - back to original English
echo    [3] List      - show available languages
echo    [4] Exit
echo  ============================================
set "C="
set /p "C=  Choose 1-4: "
if errorlevel 1 exit /b 0
if "%C:~0,1%"=="1" goto run
if "%C:~0,1%"=="2" goto restore
if "%C:~0,1%"=="3" goto list
if "%C:~0,1%"=="4" exit /b 0
echo  Invalid choice.
goto menu

:run
python hanhua.py %*
set "EXIT=%ERRORLEVEL%"
echo.
echo  (Press any key to close...)
pause >nul
exit /b %EXIT%

:list
python hanhua.py --list
echo.
echo  (Press any key to return to menu...)
pause >nul
goto menu

:restore
echo.
set "YN="
set /p "YN=  Restore original English UI? [Y/N]: "
if errorlevel 1 goto menu
if /i not "%YN:~0,1%"=="Y" goto menu
python hanhua.py --restore
echo.
echo  (Press any key to return to menu...)
pause >nul
goto menu