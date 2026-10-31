param([switch]$Force)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$logRoot = Join-Path $projectRoot '.tmp'
$logFile = Join-Path $logRoot 'dependency-install.log'
$downloadRoot = $null
$transcriptStarted = $false

function Get-CompatibleNode([string]$Candidate) {
  if (-not $Candidate -or -not (Test-Path -LiteralPath $Candidate)) { return $null }
  try {
    $major = & $Candidate -p "process.versions.node.split('.')[0]"
    if ($LASTEXITCODE -eq 0 -and [int]$major -ge 22) { return $Candidate }
  } catch {}
  return $null
}

try {
  New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
  Start-Transcript -LiteralPath $logFile -Append | Out-Null
  $transcriptStarted = $true
  Set-Location -LiteralPath $projectRoot
  foreach ($file in @('package.json','package-lock.json','scripts\check-dependencies.mjs')) {
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot $file))) { throw "Missing $file. Extract the complete project ZIP before running this script." }
  }
  Write-Host '[1/4] Checking Node.js and existing dependencies...'
  $runtimeNode = Get-CompatibleNode (Join-Path $projectRoot 'runtime\node.exe')
  if (-not $runtimeNode) { $runtimeNode = Get-CompatibleNode (Get-Command node.exe -ErrorAction SilentlyContinue).Source }
  $ready = $false
  if ($runtimeNode -and -not $Force) {
    & $runtimeNode (Join-Path $PSScriptRoot 'check-dependencies.mjs')
    $ready = $LASTEXITCODE -eq 0
  }
  if ($ready) {
    Write-Host 'Dependencies are already available. No installation is needed.' -ForegroundColor Green
  } else {
    $npmCli = $null
    if ($runtimeNode) {
      $candidate = Join-Path (Split-Path -Parent $runtimeNode) 'node_modules\npm\bin\npm-cli.js'
      if (Test-Path -LiteralPath $candidate) { $npmCli = $candidate }
    }
    if (-not $npmCli) {
      $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
      if ($runtimeNode -and $npmCommand) {
        $candidate = Join-Path (Split-Path -Parent $npmCommand.Source) 'node_modules\npm\bin\npm-cli.js'
        if (Test-Path -LiteralPath $candidate) { $npmCli = $candidate }
      }
    }
    if (-not $runtimeNode -or -not $npmCli) {
      Write-Host '[2/4] Downloading a local Node.js 24 LTS runtime from nodejs.org...'
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      $machineArch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
      $architecture = switch ($machineArch.ToUpperInvariant()) { 'AMD64' { 'x64' } 'ARM64' { 'arm64' } default { throw 'This project requires 64-bit Windows (x64 or ARM64).' } }
      $request = @{ UseBasicParsing = $true; TimeoutSec = 180 }
      $proxy = $env:HTTPS_PROXY
      if (-not $proxy -and (Get-Command git.exe -ErrorAction SilentlyContinue)) { $proxy = & git.exe -C $projectRoot config --get http.proxy }
      if ($proxy) { $request.Proxy = $proxy }
      $index = (Invoke-WebRequest @request -Uri 'https://nodejs.org/dist/index.json').Content | ConvertFrom-Json
      $release = $index | Where-Object { $_.version -match '^v24\.' -and $_.lts -and $_.files -contains "win-$architecture-zip" } | Select-Object -First 1
      if (-not $release) { throw 'Unable to find a compatible Node.js 24 LTS release.' }
      $downloadRoot = Join-Path $logRoot ('dependency-setup-' + [guid]::NewGuid().ToString('N'))
      New-Item -ItemType Directory -Path $downloadRoot | Out-Null
      $baseName = "node-$($release.version)-win-$architecture"
      $zipName = "$baseName.zip"
      $archive = Join-Path $downloadRoot $zipName
      Invoke-WebRequest @request -Uri "https://nodejs.org/dist/$($release.version)/$zipName" -OutFile $archive
      $checksums = (Invoke-WebRequest @request -Uri "https://nodejs.org/dist/$($release.version)/SHASUMS256.txt").Content
      $expected = [regex]::Match($checksums, '(?m)^([a-fA-F0-9]{64})\s+' + [regex]::Escape($zipName) + '\s*$')
      if (-not $expected.Success) { throw 'The official SHA256 checksum was not found.' }
      $stream = [IO.File]::OpenRead($archive)
      $sha = [Security.Cryptography.SHA256]::Create()
      try { $actual = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','') }
      finally { $stream.Dispose(); $sha.Dispose() }
      if ($actual -ne $expected.Groups[1].Value) { throw 'Node.js archive checksum mismatch. Download was not installed.' }
      $runtimeRoot = Join-Path $projectRoot 'runtime'
      $runtimeItem = Get-Item -LiteralPath $runtimeRoot -Force -ErrorAction SilentlyContinue
      if ($runtimeItem -and ($runtimeItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'runtime is a link. Refusing to modify files outside this project.' }
      New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
      $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
      if (Test-Path -LiteralPath $tar) {
        & $tar -xf $archive -C $runtimeRoot --strip-components 1
        if ($LASTEXITCODE -ne 0) { throw 'Node.js extraction failed. Close the application and retry.' }
      } else {
        Expand-Archive -LiteralPath $archive -DestinationPath $downloadRoot
        foreach ($entry in Get-ChildItem -LiteralPath (Join-Path $downloadRoot $baseName) -Force) {
          Copy-Item -LiteralPath $entry.FullName -Destination $runtimeRoot -Recurse -Force
        }
      }
      $runtimeNode = Get-CompatibleNode (Join-Path $runtimeRoot 'node.exe')
      $npmCli = Join-Path $runtimeRoot 'node_modules\npm\bin\npm-cli.js'
      if (-not $runtimeNode -or -not (Test-Path -LiteralPath $npmCli)) { throw 'The local Node.js runtime was not extracted correctly.' }
    } else {
      Write-Host '[2/4] Using the existing Node.js and npm.'
    }
    # npm ci replaces node_modules. Never let it follow a link into another app.
    $modules = Get-Item -LiteralPath (Join-Path $projectRoot 'node_modules') -Force -ErrorAction SilentlyContinue
    if ($modules -and ($modules.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'node_modules is a link. Refusing to modify dependencies outside this project.' }
    Write-Host '[3/4] Installing public packages from package-lock.json...'
    $previousPath = $env:PATH
    try {
      $env:PATH = (Split-Path -Parent $runtimeNode) + ';' + $previousPath
      & $runtimeNode $npmCli ci --no-audit --no-fund
      if ($LASTEXITCODE -ne 0) { throw 'npm ci failed. Check the network connection and close any running application before retrying.' }
    } finally { $env:PATH = $previousPath }
    Write-Host '[4/4] Verifying installed dependencies...'
    & $runtimeNode (Join-Path $PSScriptRoot 'check-dependencies.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Dependency verification failed.' }
    Write-Host 'Setup completed. Start the application with the one-click launcher.' -ForegroundColor Green
  }
} catch {
  Write-Host ('ERROR: ' + $_.Exception.Message) -ForegroundColor Red
  Write-Host "Log: $logFile"
  exit 1
} finally {
  if ($downloadRoot -and (Test-Path -LiteralPath $downloadRoot)) {
    $resolved = (Resolve-Path -LiteralPath $downloadRoot).Path
    $safeParent = [IO.Path]::GetFullPath($logRoot).TrimEnd('\') + '\dependency-setup-'
    if ($resolved.StartsWith($safeParent,[StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue }
  }
  if ($transcriptStarted) { Stop-Transcript | Out-Null }
}
