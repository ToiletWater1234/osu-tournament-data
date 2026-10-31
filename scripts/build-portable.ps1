$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$stageParent = Join-Path $projectRoot '.tmp\portable-build'
$stage = Join-Path $stageParent 'osu-tournament-data'
$dist = Join-Path $projectRoot 'dist'
$runtimeNode = (Get-Command node.exe -ErrorAction Stop).Source
$platform = & $runtimeNode -p 'process.platform'
$architecture = & $runtimeNode -p 'process.arch'
if ($platform -ne 'win32') { throw 'Build this portable package on Windows.' }
$archive = Join-Path $dist "osu-tournament-data-windows-$architecture.zip"

# Never clean paths outside this project's dedicated staging directory.
$expected = [IO.Path]::GetFullPath((Join-Path $projectRoot '.tmp\portable-build'))
if ([IO.Path]::GetFullPath($stageParent) -ne $expected -or -not $expected.StartsWith([IO.Path]::GetFullPath($projectRoot).TrimEnd('\') + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected staging path.' }
if (Test-Path -LiteralPath $stageParent) { Remove-Item -LiteralPath $stageParent -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage,$dist,(Join-Path $stage 'runtime') | Out-Null
foreach ($folder in @('assets','lib','public','scripts','tests')) {
  Copy-Item -LiteralPath (Join-Path $projectRoot $folder) -Destination $stage -Recurse
}
foreach ($file in @('server.mjs','launcher.ps1','start.ps1','package.json','package-lock.json','README.md')) {
  Copy-Item -LiteralPath (Join-Path $projectRoot $file) -Destination $stage
}
# The source BAT has a Unicode name; discover it rather than requiring a
# particular PowerShell source-file encoding on Windows PowerShell 5.1.
Get-ChildItem -LiteralPath $projectRoot -File -Filter *.bat | Copy-Item -Destination $stage
Copy-Item -LiteralPath $runtimeNode -Destination (Join-Path $stage 'runtime\node.exe')
$nodeVersion = & $runtimeNode -p 'process.version'
$license = Join-Path $stage 'runtime\LICENSE-node.txt'
$localLicense = Join-Path (Split-Path -Parent $runtimeNode) 'LICENSE'
if (Test-Path -LiteralPath $localLicense) { Copy-Item -LiteralPath $localLicense -Destination $license }
else {
  $request = @{ UseBasicParsing = $true; Uri = "https://raw.githubusercontent.com/nodejs/node/$nodeVersion/LICENSE"; OutFile = $license }
  $proxy = $env:HTTPS_PROXY
  if (-not $proxy -and (Get-Command git.exe -ErrorAction SilentlyContinue)) { $proxy = & git.exe -C $projectRoot config --get http.proxy }
  if ($proxy) { $request.Proxy = $proxy }
  Invoke-WebRequest @request
}

# Install from the lockfile into an empty stage, never copy the developer's
# machine-wide modules or .local OAuth. npm dependencies retain their licenses.
& npm.cmd ci --prefix $stage --omit=dev --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'Public dependency installation failed.' }
& (Join-Path $stage 'runtime\node.exe') (Join-Path $stage 'scripts\check-dependencies.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Portable dependency check failed.' }
if (Test-Path -LiteralPath (Join-Path $stage '.local')) { throw 'Private configuration must not be packaged.' }
if (Test-Path -LiteralPath (Join-Path $stage 'node_modules\@oai')) { throw 'Unexpected private dependency in package.' }
Compress-Archive -LiteralPath $stage -DestinationPath $archive -CompressionLevel Optimal -Force
Write-Output "Portable ZIP: $archive"
$stream = [IO.File]::OpenRead($archive)
$sha = [Security.Cryptography.SHA256]::Create()
try { $hash = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','') }
finally { $stream.Dispose(); $sha.Dispose() }
Write-Output ('SHA256: ' + $hash)
