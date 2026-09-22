# Installs MediaDash to start automatically at logon. Run ONCE. No admin needed.
# Uses the Windows Startup folder (Task Scheduler is blocked on this machine).
# MediaDash then runs hidden in the background — no console window, no `npm start`.
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

# Launcher: starts node with no console window, restarts it if it ever exits.
$vbsPath = Join-Path $dir 'start-hidden.vbs'
$vbs = @"
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "$dir"
Do
  sh.Run """$nodeExe"" server.js", 0, True
  WScript.Sleep 5000
Loop
"@
Set-Content -Path $vbsPath -Value $vbs -Encoding ASCII

# Shortcut in the per-user Startup folder — launches at every logon.
$startupDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$lnkPath = Join-Path $startupDir 'MediaDash.lnk'
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($lnkPath)
$lnk.TargetPath = $wscript
$lnk.Arguments = "//B //Nologo ""$vbsPath"""
$lnk.WorkingDirectory = $dir
$lnk.Description = 'MediaDash dashboard backend'
$lnk.Save()
Write-Host 'Startup shortcut created.'

# Start it right now, too.
Start-Process -FilePath $wscript -ArgumentList '//B', '//Nologo', "`"$vbsPath`"" -WorkingDirectory $dir
Start-Sleep -Seconds 3
$procs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -like '*server.js*' }
if ($procs) { Write-Host 'MediaDash is running (hidden, no window).' }
else { Write-Host 'Warning: node did not appear to start. Check config.json, then run the script again.' }
Write-Host 'Done. It starts on its own at every logon — http://localhost:3001'
Write-Host 'To remove later: Win+R -> shell:startup -> delete MediaDash.lnk'
