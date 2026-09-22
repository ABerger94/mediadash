@echo off
rem Double-click this to expose MediaDash to the internet via a free Cloudflare tunnel.
rem No account needed. Copy the https://....trycloudflare.com URL it prints into your phone.
cd /d %~dp0
if not exist cloudflared.exe (
  echo.
  echo  Put cloudflared.exe in this folder first. Download it here:
  echo  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
  echo  (Windows 64-bit)
  echo.
  pause
  exit /b 1
)
echo.
echo  Starting tunnel... look for the https://....trycloudflare.com URL below.
echo  Open that URL on your phone to reach MediaDash from anywhere.
echo  The URL changes if you restart this, so just run it again and grab the new one.
echo.
cloudflared.exe tunnel --url http://localhost:3001
pause
