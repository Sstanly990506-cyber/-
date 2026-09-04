param([switch]$Test)
$ErrorActionPreference = 'Stop'
$runner = Join-Path $PSScriptRoot 'start-ai.cmd'
if ($Test) { & $runner --test } else { & $runner }
exit $LASTEXITCODE
