# tor-web on | off | status | default on|off
param(
    [ValidateSet('on', 'off', 'status', 'default', 'revert')][string]$Command = 'status',
    [ValidateSet('on', 'off', '')][string]$Value = '',
    [string]$RevertToken = ''
)
$ErrorActionPreference = 'Stop'
$server = Join-Path $PSScriptRoot 'server.mjs'

function Invoke-Checked([string]$Program, [string[]]$Arguments, [int[]]$AllowedExitCodes = @(0)) {
    Get-Command $Program -ErrorAction Stop | Out-Null
    # Windows PowerShell turns redirected native stderr into ErrorRecords.
    # Check the actual exit status and keep native output private by default.
    $ErrorActionPreference = 'Continue'
    $PSNativeCommandUseErrorActionPreference = $false
    $encoding = [Console]::OutputEncoding
    try {
        [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
        $result = & $Program @Arguments 2>$null
    } finally { [Console]::OutputEncoding = $encoding }
    if ($LASTEXITCODE -notin $AllowedExitCodes) { throw "$Program $($Arguments -join ' ') failed (exit $LASTEXITCODE)." }
    ($result -join "`n").Trim()
}

function Read-JsonFile([string]$Path) {
    if (-not [IO.File]::Exists($Path)) { return $null }
    try { $document = [IO.File]::ReadAllText($Path) | ConvertFrom-Json }
    catch { throw "Could not read JSON from $Path." }
    if ($document -isnot [pscustomobject]) { throw "Expected a JSON object in $Path." }
    $document
}

function Write-JsonFile([string]$Path, $Document) {
    $folder = [IO.Path]::GetDirectoryName($Path)
    [IO.Directory]::CreateDirectory($folder) | Out-Null
    $temp = Join-Path $folder ([IO.Path]::GetRandomFileName())
    try {
        $json = ConvertTo-Json -InputObject $Document -Depth 50
        [IO.File]::WriteAllText($temp, $json + "`n")
        if ([IO.File]::Exists($Path)) {
            [IO.File]::Replace($temp, $Path, [NullString]::Value)
        } else {
            [IO.File]::Move($temp, $Path)
        }
    } finally { [IO.File]::Delete($temp) }
}

function Get-ServiceFile {
    $version = Invoke-Checked opencode @('--version')
    if ($version -notmatch '^opencode v2\.\d+\.\d+$') { throw 'Tor mode requires a stable OpenCode v2 release.' }
    $paths = Invoke-Checked opencode @('debug', 'paths')
    if ($paths -notmatch '(?m)^config[ \t]+(.+)$') { throw 'OpenCode did not report its service configuration directory.' }
    Join-Path ([IO.Path]::GetFullPath($Matches[1].Trim())) 'service.json'
}

function Test-ServiceRunning {
    $status = Invoke-Checked opencode @('service', 'status')
    if ($status -eq 'stopped') { return $false }
    if ($status -match '^https?://\S+$') { return $true }
    throw 'OpenCode returned an unrecognized service status.'
}

function Restart-ServiceIfNeeded([bool]$WasRunning, [bool]$Reverting) {
    if (-not $WasRunning) { return }
    $verb = if ($Reverting) { 'stop' } else { 'restart' }
    Invoke-Checked opencode @('service', $verb) | Out-Null
    if ((Test-ServiceRunning) -eq $Reverting) { throw "OpenCode service $verb did not reach the expected state." }
}

function Get-Default {
    $settings = Read-JsonFile $settingsFile
    if (-not $settings) { $settings = Read-JsonFile (Join-Path $PSScriptRoot 'settings.json') }
    if ($settings.default -eq 'off') { return 'off' }
    'on'
}

function Get-Snapshot($Environment, [string[]]$Names) {
    $snapshot = @{}
    foreach ($name in $Names) {
        if ($Environment) {
            $property = $Environment.PSObject.Properties[$name]
            if ($property) { $snapshot[$property.Name] = $property.Value }
        }
    }
    [pscustomobject]$snapshot
}

function Set-ServiceEnvironment($Values, [string[]]$Names) {
    $config = Read-JsonFile $serviceFile
    if (-not $config) { $config = [pscustomobject]@{} }
    if ($config.PSObject.Properties['env'] -and ($config.env -isnot [pscustomobject])) {
        throw 'OpenCode service configuration has an invalid environment object.'
    }
    $next = $config.env
    if (-not $next) { $next = [pscustomobject]@{} }
    foreach ($name in $Names) {
        $next.PSObject.Properties.Remove($name)
        $property = $Values.PSObject.Properties[$name]
        if ($property) { $next | Add-Member -NotePropertyName $property.Name -NotePropertyValue $property.Value }
    }
    if (@($next.PSObject.Properties).Count -gt 0) {
        $config | Add-Member -NotePropertyName env -NotePropertyValue $next -Force
    } else {
        $config.PSObject.Properties.Remove('env')
    }
    Write-JsonFile $serviceFile $config
}

function Get-Setting([string]$Name, [string]$Fallback) {
    $current = [Environment]::GetEnvironmentVariable($Name)
    if ($current) { return $current }
    if ($serviceEnv.$Name) { return $serviceEnv.$Name }
    $Fallback
}

$runtimeNames = @('TOR_WEB_DATA_DIR', 'TOR_WEB_SOCKS_PORT', 'TOR_WEB_TOR_DIR', 'TOR_WEB_IDLE_MINUTES', 'TOR_WEB_LOG_HOSTS')
function New-ModeEnvironment($Legacy) {
    if ($serviceEnv.OPENCODE_CONFIG_CONTENT -or $env:OPENCODE_CONFIG_CONTENT) {
        throw 'Tor mode needs OPENCODE_CONFIG_CONTENT for its overlay. Move the existing inline settings to your OpenCode config file before enabling Tor mode.'
    }
    $port = 0
    $configuredPort = Get-Setting TOR_WEB_SOCKS_PORT '9062'
    if ($configuredPort -notmatch '^\d+$' -or -not [int]::TryParse($configuredPort, [ref]$port) -or $port -lt 1 -or $port -gt 65533) {
        throw 'TOR_WEB_SOCKS_PORT must be an integer between 1 and 65533.'
    }
    $idle = 0.0
    $configuredIdle = Get-Setting TOR_WEB_IDLE_MINUTES '10'
    if (-not [double]::TryParse($configuredIdle, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$idle) -or
        $idle -le 0 -or [double]::IsNaN($idle) -or ($idle * 60000) -gt [int]::MaxValue) {
        throw 'TOR_WEB_IDLE_MINUTES must be positive and fit in a 32-bit millisecond timer.'
    }
    $torDir = [IO.Path]::GetFullPath((Get-Setting TOR_WEB_TOR_DIR (Join-Path $HOME 'Desktop\Tor Browser\Browser\TorBrowser\Tor')))
    $template = Join-Path $PSScriptRoot 'opencode.tor.template.json'
    $overlay = [IO.File]::ReadAllText($template).Replace('{{DIR}}', $PSScriptRoot.Replace('\', '/')) | ConvertFrom-Json
    $proxy = 'http://127.0.0.1:' + ($port + 1)
    $values = [ordered]@{
        OPENCODE_CONFIG_CONTENT = ConvertTo-Json -InputObject $overlay -Depth 30 -Compress
        HTTPS_PROXY = $proxy
        HTTP_PROXY = $proxy
        NO_PROXY = 'localhost,127.0.0.1,::1'
        NODE_USE_ENV_PROXY = '1'
        TOR_WEB_DATA_DIR = $dataDir
        TOR_WEB_SOCKS_PORT = [string]$port
        TOR_WEB_TOR_DIR = $torDir
        TOR_WEB_IDLE_MINUTES = $idle.ToString([Globalization.CultureInfo]::InvariantCulture)
        TOR_WEB_LOG_HOSTS = Get-Setting TOR_WEB_LOG_HOSTS '0'
    }
    # An older version used this install's generated file as the override.
    if ($Legacy) { $values['OPENCODE_CONFIG'] = '' }
    [pscustomobject]$values
}

function Invoke-Runtime([string]$Action, $RuntimeEnvironment) {
    $prior = @{}
    try {
        foreach ($name in $runtimeNames) {
            $prior[$name] = [Environment]::GetEnvironmentVariable($name)
            if ($RuntimeEnvironment.$name) { [Environment]::SetEnvironmentVariable($name, $RuntimeEnvironment.$name) }
        }
        $cliArgs = @($server, $Action)
        if ($Action -eq '--status') { $cliArgs += '--json' }
        if ($Action -eq '--check-revert') {
            $cliArgs += $RevertToken
            Invoke-Checked node $cliArgs @(0, 3) | Out-Null
            return $LASTEXITCODE -eq 0
        }
        Invoke-Checked node $cliArgs
    } finally {
        foreach ($name in $prior.Keys) { [Environment]::SetEnvironmentVariable($name, $prior[$name]) }
    }
}

function Get-RuntimeStatus($RuntimeEnvironment) {
    try { $health = Invoke-Runtime '--status' $RuntimeEnvironment | ConvertFrom-Json }
    catch { throw 'Could not check the Tor runtime.' }
    if ($health.running -isnot [bool] -or $health.torReady -isnot [bool] -or $null -eq $health.frontPort) {
        throw 'The Tor runtime returned an invalid status.'
    }
    $health
}

function Test-ExactEnvironment($Actual, $Expected) {
    foreach ($property in $Expected.PSObject.Properties) {
        $actualValue = $Actual.($property.Name)
        if ($actualValue -isnot [string] -or $actualValue -cne $property.Value) {
            return $false
        }
    }
    $true
}

function Protect-Previous($Snapshot) {
    # DPAPI limits access to the saved proxy settings to this Windows user.
    if ($PSVersionTable.PSEdition -eq 'Desktop') { Add-Type -AssemblyName System.Security }
    $payload = ConvertTo-Json -InputObject $Snapshot -Depth 5 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
    try {
        $protected = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')
        [Convert]::ToBase64String($protected)
    } finally { [Array]::Clear($bytes, 0, $bytes.Length) }
}

function Read-Previous($Journal) {
    try {
        if ($PSVersionTable.PSEdition -eq 'Desktop') { Add-Type -AssemblyName System.Security }
        $protected = [Convert]::FromBase64String($Journal.previous)
        $bytes = [Security.Cryptography.ProtectedData]::Unprotect($protected, $null, 'CurrentUser')
        try { [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json }
        finally { [Array]::Clear($bytes, 0, $bytes.Length) }
    } catch { throw 'The saved OpenCode settings could not be decrypted. The service configuration was left intact.' }
}

function Restore-Service($Snapshot, [string[]]$Names, [bool]$WasRunning) {
    Set-ServiceEnvironment $Snapshot $Names
    Restart-ServiceIfNeeded $WasRunning $false
}

function Restore-Journal {
    if ($journal) { Write-JsonFile $journalFile $journal }
    else { [IO.File]::Delete($journalFile) }
}

function Enable-Mode([bool]$Warm) {
    $active = if ($journal) { $journal.active } else { New-ModeEnvironment $legacyMode }
    $names = @($active.PSObject.Properties.Name)
    $before = Get-Snapshot $serviceEnv $names
    $wasRunning = Test-ServiceRunning
    $resume = $journal -and $journal.phase -ne 'active'
    $shouldRun = $wasRunning -or ($resume -and $journal.wasRunning)
    $needsConfig = -not (Test-ExactEnvironment $serviceEnv $active)
    $runtimeAction = if ($Warm) { '--on' } else { '--standby' }
    $oldRuntime = Get-RuntimeStatus $active
    $changedConfig = $false
    $changedJournal = $false
    $attemptedRestart = $false
    try {
        Invoke-Runtime $runtimeAction $active | Out-Null
        $health = Get-RuntimeStatus $active
        if (-not $health.running -or ($Warm -and -not $health.torReady) -or $health.frontPort -ne ([int]$active.TOR_WEB_SOCKS_PORT + 1)) {
            throw 'The Tor runtime did not reach the expected state.'
        }
        if ($resume -or $needsConfig) {
            $saved = $journal.previous
            if (-not $journal) {
                $previous = Get-Snapshot $serviceEnv $names
                if ($legacyMode) {
                    foreach ($key in $legacyMode.PSObject.Properties.Name) { $previous.PSObject.Properties.Remove($key) }
                }
                $saved = Protect-Previous $previous
            }
            $nextJournal = @{
                service = $serviceFile; install = $PSScriptRoot; active = $active; previous = $saved
                phase = 'enabling'; wasRunning = $shouldRun
            }
            Write-JsonFile $journalFile $nextJournal
            $changedJournal = $true
            if ($needsConfig) {
                Set-ServiceEnvironment $active $names
                $changedConfig = $true
            }
            $attemptedRestart = $shouldRun
            Restart-ServiceIfNeeded $shouldRun $false
            $nextJournal.phase = 'active'
            Write-JsonFile $journalFile $nextJournal
        }
    } catch {
        $failure = $_
        try {
            if ($changedConfig -or $attemptedRestart) { Restore-Service $before $names $wasRunning }
            if (-not $oldRuntime.running) { Invoke-Runtime '--off' $active | Out-Null }
            if ($changedJournal) { Restore-Journal }
        } catch { throw "Tor mode activation failed. Recovery also failed: $($_.Exception.Message)" }
        throw $failure
    }
}

function Disable-Mode([bool]$Reverting) {
    $active = if ($journal) { $journal.active } else { $legacyMode }
    if (-not $active) {
        if (-not $Reverting) { Invoke-Runtime '--off' ([pscustomobject]@{ TOR_WEB_DATA_DIR = $dataDir }) | Out-Null }
        return
    }
    $names = @($active.PSObject.Properties.Name)
    $previous = if ($journal) { Read-Previous $journal } else { [pscustomobject]@{} }
    $before = Get-Snapshot $serviceEnv $names
    $wasRunning = Test-ServiceRunning
    $resume = $journal -and $journal.phase -ne 'active'
    $shouldRun = $wasRunning -or ($resume -and $journal.wasRunning -and -not $Reverting)
    $changedConfig = $false
    $changedJournal = $false
    try {
        if ($Reverting -and -not (Invoke-Runtime '--check-revert' $active)) { exit 3 }
        if ($journal) {
            Write-JsonFile $journalFile @{
                service = $serviceFile; install = $PSScriptRoot; active = $active; previous = $journal.previous
                phase = 'disabling'; wasRunning = $shouldRun
            }
            $changedJournal = $true
        }
        Set-ServiceEnvironment $previous $names
        $changedConfig = $true
        Restart-ServiceIfNeeded $shouldRun $Reverting
        if (-not $Reverting) { Invoke-Runtime '--off' $active | Out-Null }
        [IO.File]::Delete($journalFile)
    } catch {
        $failure = $_
        try {
            if ($changedConfig) {
                try {
                    if ($journal -and -not $Reverting) { Invoke-Runtime '--standby' $active | Out-Null }
                } finally { Restore-Service $before $names ($wasRunning -and -not $Reverting) }
            }
            if ($changedJournal) { Restore-Journal }
        } catch { throw "Tor mode restoration failed. Recovery also failed: $($_.Exception.Message)" }
        throw $failure
    }
}

function Show-ModeStatus {
    $committedMode = Read-JsonFile $journalFile
    $active = $committedMode.active
    $actual = (Read-JsonFile $serviceFile).env
    "Default: $(Get-Default)"
    if (-not $active) {
        if ($legacyMode) { 'Tor mode: legacy configuration (run tor-web on to update or tor-web off to remove it)' }
        else { 'Tor mode: OFF' }
        return
    }
    if ($committedMode.phase -eq 'active' -and (Test-ExactEnvironment $actual $active)) { 'Tor mode: ON (OpenCode service configuration)' }
    else { 'Tor mode: INCOMPLETE (OpenCode service values differ; run tor-web on or tor-web off)' }
    $health = Get-RuntimeStatus $active
    if (-not $health.running -or $health.frontPort -ne ([int]$active.TOR_WEB_SOCKS_PORT + 1)) { 'Tor proxy: unavailable' }
    elseif ($health.torReady) { "Tor proxy: ready on 127.0.0.1:$($health.frontPort)" }
    else { "Tor proxy: listening on 127.0.0.1:$($health.frontPort), Tor starts on demand" }
}

$serviceFile = Get-ServiceFile
$serviceDir = [IO.Path]::GetDirectoryName($serviceFile)
[IO.Directory]::CreateDirectory($serviceDir) | Out-Null
try { $lock = [IO.File]::Open((Join-Path $serviceDir 'tor-web.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
catch [IO.IOException] {
    if (($_.Exception.GetBaseException().HResult -band 0xffff) -notin 32, 33) { throw }
    if ($Command -eq 'revert') { exit 4 }
    throw 'Tor mode is already switching for this OpenCode profile.'
}
try {
    $serviceEnv = (Read-JsonFile $serviceFile).env
    $journalFile = Join-Path $serviceDir 'tor-web-mode.json'
    $journal = Read-JsonFile $journalFile
    if ($journal -and ($journal.service -ne $serviceFile -or $journal.install -ne $PSScriptRoot -or -not $journal.active.TOR_WEB_DATA_DIR -or -not $journal.previous)) {
        throw 'The Tor mode state belongs to another installation or OpenCode profile.'
    }
    $requestedData = if ($journal) { $journal.active.TOR_WEB_DATA_DIR } else { Get-Setting 'TOR_WEB_DATA_DIR' (Join-Path $PSScriptRoot 'data') }
    $dataDir = [IO.Path]::GetFullPath($requestedData)
    $settingsFile = Join-Path $dataDir 'settings.json'
    $oldValues = [pscustomobject]@{
        OPENCODE_CONFIG = Join-Path $PSScriptRoot 'opencode.tor.json'
        HTTP_PROXY = 'http://127.0.0.1:9063'
        HTTPS_PROXY = 'http://127.0.0.1:9063'
        NODE_USE_ENV_PROXY = '1'
        NO_PROXY = 'localhost,127.0.0.1,::1'
    }
    $legacyMode = if (Test-ExactEnvironment $serviceEnv $oldValues) { $oldValues }

    switch ($Command) {
        'on' { Enable-Mode $true }
        'off' { Disable-Mode $false }
        'revert' {
            if (-not $RevertToken -or (Get-Default) -ne 'off') { exit 3 }
            Disable-Mode $true
            return
        }
        'default' {
            if (-not $Value) { throw 'Usage: tor-web default on|off' }
            $oldSettings = Read-JsonFile $settingsFile
            try {
                Write-JsonFile $settingsFile @{ default = $Value }
                if ($Value -eq 'on' -and ($journal.phase -ne 'active' -or -not (Test-ExactEnvironment $serviceEnv $journal.active))) { Enable-Mode $false }
                if ($Value -eq 'off' -and ($journal -or $legacyMode)) {
                    $active = if ($journal) { $journal.active } else { $legacyMode }
                    if ((Get-RuntimeStatus $active).sessions -gt 0) { 'Tor mode will switch off when the OpenCode session closes.' }
                    else { Disable-Mode $false }
                }
            } catch {
                if ($oldSettings) { Write-JsonFile $settingsFile $oldSettings }
                else { [IO.File]::Delete($settingsFile) }
                throw
            }
        }
    }
    Show-ModeStatus
} finally { $lock.Dispose() }
