param(
  [string]$TaskName = "AITokenLedgerDailyExport",
  [string]$At = "12:00",
  [string]$Timezone = "Asia/Shanghai",
  [switch]$Force
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ExportScript = Join-Path $PSScriptRoot "export-all-daily.ps1"

if (-not (Test-Path $ExportScript)) {
  throw "Cannot find export script: $ExportScript"
}

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing -and -not $Force) {
  Write-Host "Task already exists: $TaskName"
  Write-Host "Use -Force to replace it."
  exit 0
}

$Timezone = "Asia/Shanghai"
$argument = "-NoProfile -ExecutionPolicy Bypass -File `"$ExportScript`""
if ($Timezone) { $argument += " -Timezone `"$Timezone`"" }
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $argument -WorkingDirectory $ProjectRoot
$today = [DateTimeOffset]::UtcNow.ToOffset([TimeSpan]::FromHours(8)).ToString("yyyy-MM-dd")
$clock = [DateTime]::ParseExact($At, "HH:mm", [Globalization.CultureInfo]::InvariantCulture)
$boundary = "${today}T$($clock.ToString('HH:mm:ss'))+08:00"
$trigger = New-ScheduledTaskTrigger -Daily -At ([DateTimeOffset]::Parse($boundary).DateTime)
$trigger.StartBoundary = $boundary
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

if ($existing) {
  Set-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger | Out-Null
} else {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "Export every registered local agent usage source into the project data folder (Asia/Shanghai)." | Out-Null
}

Write-Host "Registered daily task: $TaskName"
Write-Host "Runs every day at: $At (UTC+08:00)"
Write-Host "Timezone: $(if ($Timezone) { $Timezone } else { 'system local timezone' })"
Write-Host "Output folder: $(Join-Path $ProjectRoot 'usage-logs')"
