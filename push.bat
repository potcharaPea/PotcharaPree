@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === กำลัง push ขึ้น GitHub ===
git add -A
git commit -m "update %date% %time%"
git push
echo.
echo === เสร็จแล้ว ===
pause
