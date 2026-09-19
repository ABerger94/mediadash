# Installs MediaDash as a Windows background task. Run ONCE.
# It then starts automatically at boot, restarts itself on crashes,
# and runs with no console window. No more `npm start`.
#
# Run from an elevated PowerShell in this folder:
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

$taskName = 'MediaDash'
$action = New-ScheduledTaskAction -Execute $nodeExe -Argument 'server.js' -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit 0

Register-ScheduledTask -TaskName $taskName `
  -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
  -Description 'MediaDash dashboard backend (qBittorrent/Sonarr/Radarr)' -Force | Out-Null

Write-Host 'Task registered. Starting MediaDash now...'
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 2
$state = (Get-ScheduledTask -TaskName $taskName).State
Write-Host "MediaDash task state: $state"
Write-Host 'Done. It now starts on its own at boot — http://localhost:3000'
