[CmdletBinding()]
param(
    [string]$EnvFile = (Join-Path (Get-Location) 'keys.env'),
    [string]$ServerName = 'x-api'
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

$url = $values['X_API_MCP_URL']
$token = $values['X_API_MCP_ACCESS_TOKEN']
if (-not $url -or -not $token) {
    throw 'X_API_MCP_URL and X_API_MCP_ACCESS_TOKEN must both be present in the environment file.'
}

[Environment]::SetEnvironmentVariable('X_API_MCP_ACCESS_TOKEN', $token, 'User')
$env:X_API_MCP_ACCESS_TOKEN = $token

& codex mcp remove $ServerName 2>$null
& codex mcp add $ServerName --url $url --bearer-token-env-var X_API_MCP_ACCESS_TOKEN
if ($LASTEXITCODE -ne 0) {
    throw "Failed to register MCP server '$ServerName'."
}

$response = Invoke-WebRequest -Method Get -Uri $url -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 20 -SkipHttpErrorCheck
if ($response.StatusCode -eq 401) {
    throw 'X API MCP rejected the configured access token. Rotate it and update keys.env.'
}

Write-Host "Registered '$ServerName' with bearer-token authentication."
Write-Host 'Restart Codex or the IDE once so it inherits the persisted user environment variable.'
