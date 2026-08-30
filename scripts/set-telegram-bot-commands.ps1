param(
  [string] $EnvFile = "keys.env",
  [string] $TokenVariable = "STAGING_TELEGRAM_BOT_TOKEN",
  # Chats that may act across every client. Each gets a per-chat scope carrying
  # the staff menu. Everyone else sees the client menu.
  [string[]] $StaffChatIds = @(),
  # Client chats to stamp explicitly. Not required -- they inherit the client
  # menu from all_private_chats -- but naming them makes the per-chat scope
  # visible to getMyCommands, which is the only way to prove what a given chat
  # actually sees.
  [string[]] $ClientChatIds = @()
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

# T5 -- two menus.
#
# The CLIENT menu is the baseline and is what goes on BOTH the default scope and
# all_private_chats. That ordering matters: all_private_chats silently overrides
# the visible default menu, so whatever lands there is what an ordinary chat
# sees. Putting the client menu there means a chat that is not explicitly staff
# can never be shown /track or a client-administration command.
#
# The STAFF menu is applied per chat, scope { type = "chat", chat_id = ... },
# which outranks all_private_chats for that one chat.
$clientCommands = @(
  @{ command = "start"; description = "Open the XMonitor guide" }
  @{ command = "help"; description = "Show commands and examples" }
  @{ command = "auth_x"; description = "Connect the X account that owns posts" }
  @{ command = "ignore"; description = "Stop alerts for a post. Usage: /ignore POST_ID" }
  @{ command = "snooze"; description = "Snooze alerts. Usage: /snooze POST_ID" }
  @{ command = "resume"; description = "Resume monitoring. Usage: /resume POST_ID" }
  @{ command = "hide_replies"; description = "Hide stored negative replies. Usage: /hide_replies POST_ID" }
  @{ command = "order_likes"; description = "Order likes. Usage: /order_likes POST_ID AMOUNT" }
  @{ command = "order_comments"; description = "Generate comments with amount form. Usage: /order_comments POST_ID" }
)

$staffCommands = $clientCommands + @(
  @{ command = "track"; description = "Track X users for a client. Usage: /track client:SLUG @user1" }
  @{ command = "clients"; description = "List clients and their chats" }
  @{ command = "client_new"; description = "Create a client. Usage: /client_new SLUG Name" }
  @{ command = "client_attach"; description = "Attach a chat. Usage: /client_attach SLUG CHAT_ID [role] [label]" }
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

function Format-Commands {
  param([object] $Response)
  if (-not $Response.result -or $Response.result.Count -eq 0) { return "(none)" }
  return (($Response.result | ForEach-Object { "/" + $_.command }) -join ", ")
}

# 1. Baseline: the client menu on both scopes that govern ordinary chats.
$defaultSetResponse = Set-BotCommands -Commands $clientCommands
$privateScope = @{ type = "all_private_chats" }
$privateSetResponse = Set-BotCommands -Commands $clientCommands -Scope $privateScope

if (-not $defaultSetResponse.ok) { throw "Telegram setMyCommands failed for default scope." }
if (-not $privateSetResponse.ok) { throw "Telegram setMyCommands failed for all_private_chats scope." }

# 2. Staff chats get the fuller menu, per chat.
$staffResults = @()
foreach ($chatId in $StaffChatIds) {
  $scope = @{ type = "chat"; chat_id = $chatId }
  $set = Set-BotCommands -Commands $staffCommands -Scope $scope
  if (-not $set.ok) { throw "Telegram setMyCommands failed for staff chat $chatId." }
  $get = Get-BotCommands -Scope $scope
  $staffResults += [PSCustomObject]@{
    ChatId = $chatId
    Menu = "staff"
    Commands = Format-Commands $get
    HasTrack = (($get.result | Where-Object { $_.command -eq "track" }) -ne $null)
  }
}

# 3. Client chats stamped explicitly so getMyCommands can prove what they see.
$clientResults = @()
foreach ($chatId in $ClientChatIds) {
  $scope = @{ type = "chat"; chat_id = $chatId }
  $set = Set-BotCommands -Commands $clientCommands -Scope $scope
  if (-not $set.ok) { throw "Telegram setMyCommands failed for client chat $chatId." }
  $get = Get-BotCommands -Scope $scope
  $clientResults += [PSCustomObject]@{
    ChatId = $chatId
    Menu = "client"
    Commands = Format-Commands $get
    # The assertion that matters: a client chat must never be offered /track
    # or any client-administration command.
    LeaksStaffCommand = (($get.result | Where-Object {
      $_.command -in @("track", "clients", "client_new", "client_attach")
    }) -ne $null)
  }
}

$me = Invoke-RestMethod -Method Post -Uri "$baseUrl/getMe" -TimeoutSec 30

[PSCustomObject]@{
  Bot = "@" + $me.result.username
  DefaultSetOk = [bool] $defaultSetResponse.ok
  DefaultCommands = Format-Commands (Get-BotCommands)
  PrivateScopeSetOk = [bool] $privateSetResponse.ok
  PrivateScopeCommands = Format-Commands (Get-BotCommands -Scope $privateScope)
} | Format-List

if ($staffResults.Count -gt 0) {
  Write-Output "Staff chat scopes:"
  $staffResults | Format-Table -AutoSize
}

if ($clientResults.Count -gt 0) {
  Write-Output "Client chat scopes:"
  $clientResults | Format-Table -AutoSize
  $leaks = $clientResults | Where-Object { $_.LeaksStaffCommand }
  if ($leaks) {
    throw "A client chat scope exposes a staff command: $(($leaks.ChatId) -join ', ')"
  }
}
