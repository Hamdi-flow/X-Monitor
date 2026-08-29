param(
  [string] $EnvFile = "keys.env",
  [string] $TokenVariable = "STAGING_TELEGRAM_BOT_TOKEN"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $EnvFile)) {
  throw "Environment file not found: $EnvFile"
}

$pairs = @{}
Get-Content -LiteralPath $EnvFile | ForEach-Object {
  $line = $_.Trim()
  if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
    $name, $value = $line.Split("=", 2)
    $pairs[$name.Trim()] = $value.Trim().Trim('"').Trim("'")
  }
}

$token = $pairs[$TokenVariable]
if (-not $token) {
  throw "$TokenVariable is missing from $EnvFile"
}

$commands = @(
  @{ command = "start"; description = "Open the XMonitor guide" }
  @{ command = "help"; description = "Show commands and examples" }
  @{ command = "auth_x"; description = "Connect the X account that owns posts" }
  @{ command = "track"; description = "Replace tracked X users. Usage: /track user1 user2" }
  @{ command = "ignore"; description = "Stop alerts for a post. Usage: /ignore POST_ID" }
  @{ command = "snooze"; description = "Snooze alerts for 4 runs. Usage: /snooze POST_ID" }
  @{ command = "resume"; description = "Resume monitoring. Usage: /resume POST_ID" }
  @{ command = "hide_replies"; description = "Hide stored negative replies. Usage: /hide_replies POST_ID" }
  @{ command = "order_likes"; description = "Order likes. Usage: /order_likes POST_ID AMOUNT" }
  @{ command = "order_comments"; description = "Generate comments with amount form. Usage: /order_comments POST_ID" }
)

$baseUrl = "https://api.telegram.org/bot$token"

function Set-BotCommands {
  param(
    [object[]] $Commands,
    [hashtable] $Scope = $null
  )

  $payload = @{ commands = $Commands }
  if ($Scope) {
    $payload.scope = $Scope
  }

  $body = $payload | ConvertTo-Json -Depth 10
  Invoke-RestMethod `
    -Method Post `
    -Uri "$baseUrl/setMyCommands" `
    -ContentType "application/json" `
    -Body $body `
    -TimeoutSec 30
}

function Get-BotCommands {
  param(
    [hashtable] $Scope = $null
  )

  if ($Scope) {
    $body = @{ scope = $Scope } | ConvertTo-Json -Depth 10
    return Invoke-RestMethod `
      -Method Post `
      -Uri "$baseUrl/getMyCommands" `
      -ContentType "application/json" `
      -Body $body `
      -TimeoutSec 30
  }

  Invoke-RestMethod `
    -Method Get `
    -Uri "$baseUrl/getMyCommands" `
    -TimeoutSec 30
}

$defaultSetResponse = Set-BotCommands -Commands $commands
$privateScope = @{ type = "all_private_chats" }
$privateSetResponse = Set-BotCommands -Commands $commands -Scope $privateScope

if (-not $defaultSetResponse.ok) {
  throw "Telegram setMyCommands failed for default scope."
}

if (-not $privateSetResponse.ok) {
  throw "Telegram setMyCommands failed for all_private_chats scope."
}

$me = Invoke-RestMethod `
  -Method Post `
  -Uri "$baseUrl/getMe" `
  -TimeoutSec 30

$defaultGetResponse = Get-BotCommands
$privateGetResponse = Get-BotCommands -Scope $privateScope

[PSCustomObject]@{
  Bot = "@" + $me.result.username
  DefaultSetOk = [bool] $defaultSetResponse.ok
  DefaultCommands = (($defaultGetResponse.result | ForEach-Object { "/" + $_.command }) -join ", ")
  PrivateScopeSetOk = [bool] $privateSetResponse.ok
  PrivateScopeCommands = (($privateGetResponse.result | ForEach-Object { "/" + $_.command }) -join ", ")
} | Format-List
