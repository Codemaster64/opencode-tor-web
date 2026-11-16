# tor-web on | off | status | default on|off        (profile function `tor-web`)
#   on           Tor mode: everything opencode sends to the internet goes through Tor (web search/fetch, shell, model
#                list, cloud model APIs). Starts Tor now; it stays up until `tor-web off` or opencode closes, and afterwards starts
#                by itself when needed (stopping after 10 idle minutes).
#   off          Normal opencode: its own web search and fetch, direct internet, normal shell. Stops Tor.
#   default on   Tor mode stays on across opencode starts until you run `tor-web off`.
#   default off  Tor mode is per session: opencode starts normal; `tor-web on` routes that session through Tor, and
#                it switches back off by itself when opencode closes.
#   status       Current mode, the default, and whether Tor is running.
# The mode lives in the opencode background service's environment (~\.config\opencode\service.json); the Tor settings
# are in opencode.tor.json here (loaded via OPENCODE_CONFIG), so your main opencode.json is never touched.
param(
    [ValidateSet('on', 'off', 'status', 'default')][string]$Command = 'status',
    [ValidateSet('on', 'off', '')][string]$Value = ''
)
$ErrorActionPreference = 'Stop'
$server = Join-Path $PSScriptRoot 'server.mjs'
$settingsFile = Join-Path $PSScriptRoot 'settings.json'
$sessionFile = Join-Path $PSScriptRoot 'data\session.json'
$modeEnv = [ordered]@{
    OPENCODE_CONFIG    = Join-Path $PSScriptRoot 'opencode.tor.json'
    HTTPS_PROXY        = 'http://127.0.0.1:9063'
    HTTP_PROXY         = 'http://127.0.0.1:9063'
    NO_PROXY           = 'localhost,127.0.0.1,::1'   # only local models skip Tor
    NODE_USE_ENV_PROXY = '1'
}
function Get-OcService { Get-CimInstance Win32_Process -Filter "Name='opencode.exe'" | Where-Object CommandLine -match 'serve --service' | Select-Object -First 1 }
function Get-OcWindows { @(Get-CimInstance Win32_Process -Filter "Name='opencode.exe'" | Where-Object CommandLine -notmatch ' serve').Count }
function Get-ModeKeys { try { @((Get-Content "$HOME\.config\opencode\service.json" -Raw | ConvertFrom-Json).env.PSObject.Properties.Name | Where-Object { $_ -in $modeEnv.Keys }) } catch { @() } }
function Test-ModeOn { (Get-ModeKeys).Count -eq $modeEnv.Count }
function Get-Default { try { (Get-Content $settingsFile -Raw | ConvertFrom-Json).default } catch { 'on' } }
function Restart-IfRunning { if (Get-OcService) { opencode service restart | Out-Null; 'opencode background service restarted (open opencode windows reconnect).' } }
function Find-Pwsh7 {
    # opencode's shell must be PowerShell 7: Windows PowerShell 5.1 ignores HTTPS_PROXY and would connect directly
    $cmd = Get-Command pwsh -ErrorAction SilentlyContinue
    if (-not $cmd) { throw 'PowerShell 7 (pwsh) is required: winget install Microsoft.PowerShell' }
    $path = $cmd.Source
    if ($path -match '\\WindowsApps\\') { # Store install: opencode can't use the app alias, so take the real (versioned) folder
        $pkg = Get-AppxPackage Microsoft.PowerShell -ErrorAction SilentlyContinue | Sort-Object Version -Descending | Select-Object -First 1
        if ($pkg) { $path = Join-Path $pkg.InstallLocation 'pwsh.exe' }
    }
    $path -replace '\\', '/'
}
function Write-TorConfig { # opencode.tor.json is generated for this machine from the template (never committed)
    $text = (Get-Content (Join-Path $PSScriptRoot 'opencode.tor.template.json') -Raw).
        Replace('{{DIR}}', ($PSScriptRoot -replace '\\', '/')).Replace('{{PWSH}}', (Find-Pwsh7))
    [IO.File]::WriteAllText($modeEnv.OPENCODE_CONFIG, $text)
}
function Enable-Mode {
    Write-TorConfig                                          # also picks up a PowerShell update's new path
    Remove-Item $sessionFile -ErrorAction SilentlyContinue   # a new Tor-mode session starts now
    foreach ($k in $modeEnv.Keys) { opencode service set env $k $modeEnv[$k] | Out-Null }
    Restart-IfRunning
}
function Disable-Mode {
    node $server --off | Out-Null
    foreach ($k in $modeEnv.Keys) { opencode service unset env $k | Out-Null }
    Remove-Item $sessionFile -ErrorAction SilentlyContinue
    Restart-IfRunning
}

switch ($Command) {
    'on' {
        Enable-Mode
        $nodeArgs = @($server, '--on')
        $svc = Get-OcService
        if ($svc) { $nodeArgs += '--owner', $svc.ProcessId } # Tor also stops when opencode's service exits
        node @nodeArgs | Out-Null
    }
    'off' { Disable-Mode }
    'default' {
        if (-not $Value) { throw 'usage: tor-web default on|off' }
        Set-Content $settingsFile (@{ default = $Value } | ConvertTo-Json -Compress)
        if ($Value -eq 'on' -and -not (Test-ModeOn)) { Enable-Mode }
        if ($Value -eq 'off' -and (Test-ModeOn)) {
            if ((Get-OcWindows) -eq 0) { Disable-Mode } else { 'Tor mode stays on for this session and switches off when opencode closes.' }
        }
    }
}
$n = (Get-ModeKeys).Count
$mode = if ($n -eq $modeEnv.Count) { 'ON  - opencode reaches the internet only through Tor' }
        elseif ($n -eq 0) { 'OFF - normal opencode, direct internet' }
        else { 'HALF-SWITCHED (opencode web may fail) - run `tor-web off` or `tor-web on`' }
$def = if ((Get-Default) -eq 'off') { 'off (per session: `tor-web on` lasts until opencode closes)' } else { 'on (Tor mode stays on until `tor-web off`)' }
"Tor mode: $mode"
"Default:  $def"
if (Test-ModeOn) { node $server --status } else { 'Tor: not used' }
