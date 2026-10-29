$appRoot = $PSScriptRoot
$portableNode = Join-Path $appRoot 'runtime\node.exe'
$runtimeNode = if (Test-Path -LiteralPath $portableNode) { $portableNode } else { (Get-Command node.exe -ErrorAction SilentlyContinue).Source }
if (-not $runtimeNode -or -not (Test-Path -LiteralPath $runtimeNode)) { throw 'Node.js was not found in the application runtime folder or PATH.' }
if (-not (Test-Path -LiteralPath (Join-Path $appRoot 'node_modules'))) { throw 'The relative node_modules folder was not found.' }
& $runtimeNode (Join-Path $appRoot 'server.mjs')
