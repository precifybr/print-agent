@echo off
setlocal EnableExtensions

title SYNC PRINT ASSISTANT
cd /d "%~dp0"

echo [1/2] Iniciando sync...
echo Pasta: %CD%
echo.

call npm run sync
if errorlevel 1 goto sync_failed

echo.
echo SYNC CONCLUIDO
goto end

:sync_failed
echo.
echo SYNC FALHOU
echo Verifique o log acima para identificar a etapa exata que falhou.

:end
echo.
pause
