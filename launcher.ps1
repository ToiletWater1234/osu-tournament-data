$ErrorActionPreference = 'Stop'
$appRoot = $PSScriptRoot
$appUrl = 'http://127.0.0.1:4173'
$portableNode = Join-Path $appRoot 'runtime\node.exe'
$runtimeNode = if (Test-Path -LiteralPath $portableNode) { $portableNode } else { (Get-Command node.exe -ErrorAction SilentlyContinue).Source }
$dataRoot = $appRoot
$serverScript = Join-Path $appRoot 'server.mjs'
$moduleLink = Join-Path $appRoot 'node_modules'
$logDir = Join-Path $dataRoot '.tmp\launcher'
$stdoutLog = Join-Path $logDir 'server.log'
$stderrLog = Join-Path $logDir 'server-error.log'
$pidFile = Join-Path $dataRoot '.tmp\server.pid'

function Test-AppReady {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $appUrl -TimeoutSec 1
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

if (-not $runtimeNode -or -not (Test-Path -LiteralPath $runtimeNode)) {
  throw 'Node.js was not found in the application runtime folder or PATH.'
}
if (-not (Test-Path -LiteralPath $serverScript)) {
  throw "Server script was not found: $serverScript"
}
if (-not (Test-Path -LiteralPath $moduleLink)) { throw "Application dependencies were not found: $moduleLink" }
& $runtimeNode (Join-Path $appRoot 'scripts\check-dependencies.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Dependency check failed. Open PowerShell in this project folder and run: npm ci' }

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
if (Test-Path -LiteralPath $pidFile) {
  $oldPid = [int](Get-Content -LiteralPath $pidFile -Raw)
  $oldProcess = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
  if ($oldProcess -and $oldProcess.ProcessName -eq 'node') {
    Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 300
  }
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}
if (-not (Test-AppReady)) {
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $runtimeNode
  $startInfo.Arguments = '"' + $serverScript + '"'
  $startInfo.WorkingDirectory = $appRoot
  $startInfo.UseShellExecute = $true
  $startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $process = [System.Diagnostics.Process]::Start($startInfo)
  if (-not $process) { throw 'The server process could not be created.' }
  $ready = $false
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 500
    if (Test-AppReady) { $ready = $true; break }
  }
  if (-not $ready) {
    throw 'The application did not become ready within 10 seconds.'
  }
}

$browserInfo = New-Object System.Diagnostics.ProcessStartInfo
$browserInfo.FileName = $appUrl
$browserInfo.UseShellExecute = $true
[System.Diagnostics.Process]::Start($browserInfo) | Out-Null
