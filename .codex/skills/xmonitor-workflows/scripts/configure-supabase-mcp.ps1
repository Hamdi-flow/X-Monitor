[CmdletBinding()]
param(
    [string]$EnvFile = (Join-Path (Get-Location) 'keys.env'),
    [string]$ServerName = 'supabase',
    [string]$ServerUrl = 'https://mcp.supabase.com/mcp?project_ref=npytqidroqxgikaqofmq'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $EnvFile)) {
    throw "Environment file not found: $EnvFile"
}

$values = @{}
Get-Content -LiteralPath $EnvFile | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
        $name, $value = $line.Split('=', 2)
        $values[$name.Trim()] = $value.Trim().Trim('"').Trim("'")
    }
}

$token = $values['SUPABASE_ACCESS_TOKEN']
if (-not $token) {
    throw 'SUPABASE_ACCESS_TOKEN must be present in the environment file.'
}

[Environment]::SetEnvironmentVariable('SUPABASE_ACCESS_TOKEN', $token, 'User')
$env:SUPABASE_ACCESS_TOKEN = $token

& codex mcp remove $ServerName 2>$null
& codex mcp add $ServerName --url $ServerUrl --bearer-token-env-var SUPABASE_ACCESS_TOKEN
if ($LASTEXITCODE -ne 0) {
    throw "Failed to register MCP server '$ServerName'."
}

$response = Invoke-WebRequest -Method Get -Uri $ServerUrl -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 20 -SkipHttpErrorCheck
if ($response.StatusCode -eq 401) {
    throw 'Supabase rejected the configured personal access token. Generate a replacement and update keys.env.'
}

Write-Host "Registered '$ServerName' with bearer-token authentication."
Write-Host 'Restart Codex or the IDE once so it inherits the persisted user environment variable.'
