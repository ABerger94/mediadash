# MediaDash download tracker — pushes qBittorrent status to a GitHub gist every 5 minutes.
# Runs hidden via start-tracker-hidden.vbs (Startup folder). No admin needed.
# Your qBittorrent password and GitHub token live ONLY in config.local.json on this laptop.

$ErrorActionPreference = 'Continue'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $dir 'config.local.json'
$logPath = Join-Path $dir 'tracker.log'

function Write-Log($msg) {
  $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Add-Content -Path $logPath -Value "$ts $msg" -ErrorAction SilentlyContinue
}

if (-not (Test-Path $configPath)) {
  Write-Log 'config.local.json missing — run install-tracker.ps1 first'
  exit 1
}
$cfg = Get-Content $configPath -Raw | ConvertFrom-Json
if ($cfg.qb_pass -like '*PUT_YOUR*' -or $cfg.github_pat -like '*PASTE*') {
  Write-Log 'config.local.json still has placeholder values — fill them in and restart'
  exit 1
}

function Get-QbSummary {
  try {
    $loginBody = @{ username = $cfg.qb_user; password = $cfg.qb_pass }
    $login = Invoke-WebRequest -Uri "$($cfg.qb_url)/api/v2/auth/login" -Method Post -Body $loginBody -SessionVariable ws -UseBasicParsing -TimeoutSec 15
  } catch {
    return @{ status = 'qbittorrent_unreachable'; updated_at = (Get-Date).ToString('o') }
  }
  if ($login.Content -ne 'Ok.') {
    return @{ status = 'qbittorrent_auth_failed'; updated_at = (Get-Date).ToString('o') }
  }
  try {
    $torrents = Invoke-RestMethod -Uri "$($cfg.qb_url)/api/v2/torrents/info" -WebSession $ws -TimeoutSec 20
    $transfer = Invoke-RestMethod -Uri "$($cfg.qb_url)/api/v2/transfer/info" -WebSession $ws -TimeoutSec 20
  } catch {
    return @{ status = 'qbittorrent_api_failed'; updated_at = (Get-Date).ToString('o') }
  }

  $downloading = 0; $stalled = 0; $paused = 0; $seeding = 0; $other = 0
  $items = @()
  foreach ($t in $torrents) {
    $state = [string]$t.state
    $done = $t.progress -ge 1
    if ($done) { $seeding++ }
    elseif ($state -like 'paused*') { $paused++ }
    elseif ($state -like 'stalled*') { $stalled++ }
    elseif ($state -match 'DL|downloading|allocating') { $downloading++ }
    else { $other++ }
    $items += [ordered]@{
      name     = $t.name
      progress = [math]::Round([double]$t.progress, 4)
      state    = $state
      dlspeed  = [long]$t.dlspeed
      eta      = [long]$t.eta
      size     = [long]$t.size
    }
  }

  return [ordered]@{
    status     = 'ok'
    updated_at = (Get-Date).ToString('o')
    totals     = [ordered]@{
      down_speed  = [long]$transfer.dl_info_speed
      up_speed    = [long]$transfer.up_info_speed
      downloading = $downloading
      stalled     = $stalled
      paused      = $paused
      seeding     = $seeding
      other       = $other
      total       = $torrents.Count
    }
    torrents   = $items
  }
}

function Push-Once {
  $summary = Get-QbSummary
  $inner = ($summary | ConvertTo-Json -Depth 6 -Compress)
  $body = (@{ files = @{ 'mediadash-status.json' = @{ content = $inner } } } | ConvertTo-Json -Depth 6 -Compress)
  $headers = @{ Authorization = "Bearer $($cfg.github_pat)"; 'User-Agent' = 'mediadash-tracker' }
  try {
    Invoke-RestMethod -Uri "https://api.github.com/gists/$($cfg.gist_id)" -Method Patch -Headers $headers -Body $body -ContentType 'application/json' -TimeoutSec 30 | Out-Null
  } catch {
    Write-Log "gist push failed: $($_.Exception.Message)"
  }
}

if ($args -contains '-Test') {
  $s = Get-QbSummary
  $s | ConvertTo-Json -Depth 6 | Write-Host
  exit 0
}

while ($true) {
  try { Push-Once } catch { Write-Log "loop error: $($_.Exception.Message)" }
  Start-Sleep -Seconds 300
}
