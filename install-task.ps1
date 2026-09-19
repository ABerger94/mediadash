# Installs MediaDash as a Windows background task. Run ONCE. No admin needed.
# It then starts automatically at logon, restarts itself on crashes,
# and runs with no console window. No more `npm start`.
#
# In a Terminal/PowerShell window inside this folder, run:
#   powershell -ExecutionPolicy Bypass -File install-task.ps1

$ErrorActionPreference = 'Stop'

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverJs = Join-Path $dir 'server.js'
if (-not (Test-Path $serverJs)) { Write-Host "server.js not found in $dir"; exit 1 }

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { Write-Host 'Node.js not found on PATH. Install it first: https://nodejs.org'; exit 1 }
$nodeExe = $nodeCmd.Source

if (-not (Test-Path (Join-Path $dir 'config.json'))) {
  Write-Host 'config.json not found. Copy config.example.json to config.json and fill it in first.'
  exit 1
}

# Generate a launcher that starts node with no console window.
$vbsPath = Join-Path $dir 'start-hidden.vbs'
$vbs = @"
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "$dir"
sh.Run """$nodeExe"" server.js", 0, False
"@
Set-Content -Path $vbsPath -Value $vbs -Encoding ASCII

$taskName = 'MediaDash'
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$action = New-ScheduledTaskAction -Execute $wscript -Argument "//B //Nologo ""$vbsPath""" -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit 0 `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $taskName `
  -Action $action -Trigger $trigger -Settings $settings `
  -Description 'MediaDash dashboard backend (qBittorrent/Sonarr/Radarr)' -Force | Out-Null

Write-Host 'Task registered. Starting MediaDash now...'
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 3
$state = (Get-ScheduledTask -TaskName $taskName).State
Write-Host "MediaDash task state: $state"
Write-Host 'Done. It starts on its own at logon — http://localhost:3000'
