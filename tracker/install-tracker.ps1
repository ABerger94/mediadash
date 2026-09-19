# Installs the MediaDash download tracker. Run ONCE. No admin needed.
# 1. Copies config.template.json -> config.local.json (your secrets stay on this laptop)
# 2. Opens config.local.json in Notepad so you can paste in your values
# 3. Adds a hidden launcher to the Startup folder so it runs at every logon
#
# In a PowerShell window inside the tracker folder, run:
#   powershell -ExecutionPolicy Bypass -File install-tracker.ps1

$ErrorActionPreference = 'Stop'

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $dir 'config.local.json'
$templatePath = Join-Path $dir 'config.template.json'

if (-not (Test-Path $configPath)) {
  Copy-Item $templatePath $configPath
  Write-Host 'Created config.local.json'
} else {
  Write-Host 'config.local.json already exists — leaving it alone'
}

# Hidden launcher: runs push-status.ps1 with no window, restarts it if it ever exits.
$vbsPath = Join-Path $dir 'start-tracker-hidden.vbs'
$vbs = @"
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "$dir"
Do
  sh.Run "powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File ""$dir\push-status.ps1""", 0, True
  WScript.Sleep 5000
Loop
"@
Set-Content -Path $vbsPath -Value $vbs -Encoding ASCII

# Shortcut in the per-user Startup folder — launches at every logon.
$startupDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$lnkPath = Join-Path $startupDir 'MediaDash Tracker.lnk'
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($lnkPath)
$lnk.TargetPath = $wscript
$lnk.Arguments = "//B //Nologo ""$vbsPath"""
$lnk.WorkingDirectory = $dir
$lnk.Description = 'MediaDash download tracker'
$lnk.Save()
Write-Host 'Startup shortcut created.'

# Open the config so values can be pasted in now.
Write-Host ''
Write-Host 'Opening config.local.json — paste in your qBittorrent password,'
Write-Host 'the gist ID Milk gave you, and your GitHub token, then save and close.'
Write-Host ''
Start-Process notepad.exe $configPath

# Start it right now, too.
Start-Process -FilePath $wscript -ArgumentList '//B', '//Nologo', "`"$vbsPath`"" -WorkingDirectory $dir
Write-Host 'Tracker started (hidden, no window).'
Write-Host 'To remove later: Win+R -> shell:startup -> delete MediaDash Tracker.lnk'
