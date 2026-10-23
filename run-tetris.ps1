$ErrorActionPreference = 'Stop'
$projectPath = Join-Path $PSScriptRoot 'buriburiland-tetris-ai'
$healthUrl = 'http://127.0.0.1:8765/health'
$running = $false
try {
    $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
    $running = $health.app -eq 'buriburiland-tetris-ai'
} catch { }
if (-not $running) {
    Start-Process -FilePath 'node.exe' -ArgumentList 'scripts/serve.mjs' -WorkingDirectory $projectPath -WindowStyle Hidden -RedirectStandardOutput (Join-Path $projectPath 'logs/local-server.log') -RedirectStandardError (Join-Path $projectPath 'logs/local-server-error.log')
    for ($attempt = 0; $attempt -lt 25; $attempt++) {
        Start-Sleep -Milliseconds 100
        try {
            $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 1
            if ($health.app -eq 'buriburiland-tetris-ai') { $running = $true; break }
        } catch { }
    }
}
if (-not $running) { throw 'Local server failed. See logs/local-server-error.log.' }
Start-Process 'http://127.0.0.1:8765/demo'
