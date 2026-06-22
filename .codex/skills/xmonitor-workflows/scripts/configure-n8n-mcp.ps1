[CmdletBinding()]
param(
    [string]$EnvFile = (Join-Path (Get-Location) 'keys.env'),
    [string]$ServerName = 'xmonitor-staging'
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

$url = $values['N8N_MCP_URL']
$token = $values['N8N_MCP_ACCESS_TOKEN']
if (-not $url -or -not $token) {
    throw 'N8N_MCP_URL and N8N_MCP_ACCESS_TOKEN must both be present in the environment file.'
}

[Environment]::SetEnvironmentVariable('N8N_MCP_ACCESS_TOKEN', $token, 'User')
$env:N8N_MCP_ACCESS_TOKEN = $token

& codex mcp remove $ServerName 2>$null
& codex mcp add $ServerName --url $url --bearer-token-env-var N8N_MCP_ACCESS_TOKEN
if ($LASTEXITCODE -ne 0) {
    throw "Failed to register MCP server '$ServerName'."
}

$response = Invoke-WebRequest -Method Get -Uri $url -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 20 -SkipHttpErrorCheck
if ($response.StatusCode -eq 401) {
    throw 'n8n rejected the configured MCP access token. Rotate it in n8n and update keys.env.'
}

Write-Host "Registered '$ServerName' with bearer-token authentication."
Write-Host 'Restart Codex or the IDE once so it inherits the persisted user environment variable.'
