# Run with Windows PowerShell 5.1 or PowerShell 7. Only the external programs
# are mocked; each test switches real service.json and mode files in isolation.
$ErrorActionPreference = 'Stop'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('tor-web-switch-test-' + [guid]::NewGuid())
$fixture = Join-Path $testRoot 'install'
$profileConfig = Join-Path $testRoot 'profile'
$serviceFile = Join-Path $profileConfig 'service.json'
$dataDir = Join-Path $testRoot 'data'
$modeScript = Join-Path $fixture 'tor-web.ps1'
$previousEnvironment = @{}
$testContext = @{}
$proxyBefore = 'http://example:proxy-test-credential@proxy.invalid:8080'
$serviceBefore = '{"port":46544,"env":{"HTTPS_PROXY":"' + $proxyBefore + '","HTTP_PROXY":"","UNRELATED":"keep"}}'

function Assert-That($Condition, $Message) {
    if (-not $Condition) { throw $Message }
}

function Read-ServiceFile { Get-Content -Raw -LiteralPath $serviceFile | ConvertFrom-Json }

function Reset-Fixture {
    [IO.File]::WriteAllText($serviceFile, $serviceBefore)
    [IO.File]::Delete((Join-Path $profileConfig 'tor-web-mode.json'))
    Get-ChildItem -Force -File -LiteralPath $dataDir | Remove-Item -Force
    $testContext.serviceRunning = $true
    $testContext.runtimeReady = $false
    $testContext.torReady = $false
    $testContext.sessions = 0
    $testContext.runtimeError = $false
    $testContext.restartError = $false
    $testContext.trace = [Collections.Generic.List[string]]::new()
}

function opencode {
    $global:LASTEXITCODE = 0
    switch ($args -join ' ') {
        '--version' { 'opencode v2.0.31' }
        'debug paths' { "config     $profileConfig" }
        'service status' { if ($testContext.serviceRunning) { 'http://127.0.0.1:46544' } else { 'stopped' } }
        'service stop' { $testContext.trace.Add('stop'); $testContext.serviceRunning = $false }
        { $_ -in 'service start', 'service restart' } {
            $testContext.trace.Add('start')
            $testContext.serviceRunning = $false
            if ($testContext.restartError) {
                $testContext.restartError = $false
                $global:LASTEXITCODE = 11
            } else {
                if ((Read-ServiceFile).env.HTTP_PROXY -eq 'http://127.0.0.1:12063' -and -not $testContext.runtimeReady) {
                    throw 'The service started with a proxy that was still down.'
                }
                $testContext.serviceRunning = $true
            }
        }
        # OpenCode service set/unset stop the service. This makes the old
        # script's post-mutation service detection reproduce the real failure.
        { $_ -match '^service (set|unset) env ' } { $testContext.serviceRunning = $false }
        default { throw "Unexpected OpenCode invocation: $($args[0..1] -join ' ')" }
    }
}

function node {
    $global:LASTEXITCODE = 0
    switch ($args[1]) {
        { $_ -in '--standby', '--on' } {
            $testContext.trace.Add('runtime start')
            if ($testContext.runtimeError) {
                Write-Error '[tor-web] Tor bootstrap stalled for 120s. Last stage: 10% Connected to a relay.' -ErrorAction Continue
                $global:LASTEXITCODE = 22
                return
            }
            $testContext.runtimeReady = $true
            if ($args[1] -eq '--on') { $testContext.torReady = $true }
        }
        '--off' {
            $testContext.trace.Add('runtime stop')
            $testContext.offData = $env:TOR_WEB_DATA_DIR
            $testContext.runtimeReady = $false
            $testContext.torReady = $false
        }
        '--check-revert' {
            if ($args[2] -ne 'current-ticket' -or $testContext.sessions -gt 0) { $global:LASTEXITCODE = 3 }
        }
        '--status' {
            @{
                running = $testContext.runtimeReady
                torReady = $testContext.torReady
                frontPort = 12063
                sessions = $testContext.sessions
            } | ConvertTo-Json -Compress
        }
        default { throw 'Unexpected runtime invocation' }
    }
}

function Get-CimInstance {
    if ($testContext.serviceRunning) { [pscustomobject]@{CommandLine = 'serve --service'; ProcessId = 12345} }
}

$failures = [Collections.Generic.List[string]]::new()
function Test-SwitchCase($Name, [scriptblock]$Case) {
    Reset-Fixture
    try { & $Case; "PASS $Name" }
    catch { $failures.Add($Name); "FAIL ${Name}: $($_.Exception.Message)`n$($_.ScriptStackTrace)" }
}

try {
    foreach ($path in @($fixture, $profileConfig, $dataDir)) { [IO.Directory]::CreateDirectory($path) | Out-Null }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'tor-web.ps1'), (Join-Path $PSScriptRoot 'opencode.tor.template.json') -Destination $fixture
    $fixtureEnvironment = @{
        TOR_WEB_DATA_DIR = $dataDir
        TOR_WEB_SOCKS_PORT = '12062'
        TOR_WEB_TOR_DIR = (Join-Path $testRoot 'Tor Browser')
        TOR_WEB_IDLE_MINUTES = '0.25'
        TOR_WEB_SEARCH_FALLBACK = 'exa'
        OPENCODE_CONFIG_CONTENT = $null
    }
    foreach ($key in $fixtureEnvironment.Keys) {
        $previousEnvironment[$key] = [Environment]::GetEnvironmentVariable($key)
        [Environment]::SetEnvironmentVariable($key, $fixtureEnvironment[$key])
    }

    Test-SwitchCase 'starts the runtime before restarting the previously running service' {
        $output = & $modeScript on
        $envAfter = (Read-ServiceFile).env
        Assert-That $testContext.serviceRunning 'The previously running service remained stopped.'
        Assert-That (($testContext.trace -join ',') -match '^runtime start,.*start$') 'The service was not restarted after the runtime was ready.'
        Assert-That ($envAfter.HTTP_PROXY -ceq 'http://127.0.0.1:12063') 'The service did not receive the derived proxy port.'
        Assert-That ($envAfter.TOR_WEB_SOCKS_PORT -ceq '12062') 'The service did not receive the SOCKS port.'
        Assert-That ($envAfter.TOR_WEB_TOR_DIR -ceq $fixtureEnvironment.TOR_WEB_TOR_DIR) 'The service did not receive the Tor path.'
        Assert-That ($envAfter.TOR_WEB_IDLE_MINUTES -ceq '0.25') 'The service did not receive the idle timeout.'
        Assert-That ($envAfter.TOR_WEB_SEARCH_FALLBACK -ceq 'exa') 'The service did not receive the enabled search fallback.'
        Assert-That ($envAfter.TOR_WEB_DATA_DIR -ceq $dataDir) 'The service did not receive the runtime data directory.'
        Assert-That (($output -join ' ') -notmatch 'proxy-test-credential') 'The switch exposed the previous proxy credential.'
    }

    Test-SwitchCase 'restores previous values including an empty proxy on off' {
        & $modeScript on | Out-Null
        & $modeScript off | Out-Null
        $envAfter = (Read-ServiceFile).env
        Assert-That ($envAfter.HTTPS_PROXY -ceq $proxyBefore) 'The previous proxy value was lost.'
        Assert-That ($envAfter.HTTP_PROXY -ceq '') 'The previous empty proxy value was lost.'
        Assert-That ($envAfter.UNRELATED -ceq 'keep') 'An unrelated service setting was lost.'
        Assert-That ($null -eq $envAfter.PSObject.Properties['TOR_WEB_SOCKS_PORT']) 'A previously absent value was not removed.'
        Assert-That ($testContext.serviceRunning -and -not $testContext.runtimeReady) 'Off left the service stopped or the runtime active.'
    }

    Test-SwitchCase 'leaves the service untouched if Tor startup fails' {
        $testContext.runtimeError = $true
        $failureMessage = ''
        try { & $modeScript on | Out-Null } catch { $failureMessage = $_.Exception.Message }
        Assert-That ($failureMessage -match 'Last stage: 10% Connected to a relay') 'Tor startup lost the bootstrap diagnostic.'
        Assert-That ($testContext.serviceRunning -and $testContext.trace -notcontains 'start' -and $testContext.trace -notcontains 'stop') 'A failed runtime interrupted the service.'
        Assert-That ([IO.File]::ReadAllText($serviceFile) -ceq $serviceBefore) 'Tor startup failure changed service settings.'
    }

    Test-SwitchCase 'rolls back and relaunches the prior service if restart fails' {
        $testContext.restartError = $true
        $failureMessage = ''
        try { & $modeScript on | Out-Null } catch { $failureMessage = $_.Exception.Message }
        Assert-That ($failureMessage -match 'exit 11') 'Service start failure was not reported.'
        Assert-That (@($testContext.trace | Where-Object { $_ -eq 'start' }).Count -eq 2) 'Rollback did not retry service startup.'
        Assert-That ($testContext.serviceRunning -and -not $testContext.runtimeReady) 'Rollback did not recover the previous running service.'
        Assert-That ((Read-ServiceFile).env.HTTPS_PROXY -ceq $proxyBefore) 'Rollback did not recover the previous proxy.'
    }

    Test-SwitchCase 'rejects port values that leave no room for the other two ports' {
        $env:TOR_WEB_SOCKS_PORT = '65534'
        try {
            $reportedFailure = $false
            try { & $modeScript on | Out-Null } catch { $reportedFailure = $true }
            Assert-That $reportedFailure 'An invalid SOCKS port was accepted.'
            Assert-That ($testContext.trace.Count -eq 0) 'Invalid port validation happened after side effects.'
        } finally { $env:TOR_WEB_SOCKS_PORT = '12062' }
    }

    Test-SwitchCase 'loads the Tor overlay alongside an existing custom OpenCode config file' {
        $cfg = Read-ServiceFile
        $custom = Join-Path $testRoot 'custom-opencode.jsonc'
        $cfg.env | Add-Member -NotePropertyName OPENCODE_CONFIG -NotePropertyValue $custom
        [IO.File]::WriteAllText($serviceFile, (ConvertTo-Json $cfg -Depth 5))
        & $modeScript on | Out-Null
        Assert-That ((Read-ServiceFile).env.OPENCODE_CONFIG -ceq $custom) 'Tor mode replaced the custom config path.'
        Assert-That ([bool](Read-ServiceFile).env.OPENCODE_CONFIG_CONTENT) 'Tor mode did not set the overlay.'
        & $modeScript off | Out-Null
        Assert-That ((Read-ServiceFile).env.OPENCODE_CONFIG -ceq $custom) 'Off removed the custom config path.'
        Assert-That (-not (Read-ServiceFile).env.OPENCODE_CONFIG_CONTENT) 'Off left the Tor overlay installed.'
    }

    Test-SwitchCase 'preserves an existing inline configuration when activation is incompatible' {
        $cfg = Read-ServiceFile
        $userInline = '{"websearch":true}'
        $cfg.env | Add-Member -NotePropertyName OPENCODE_CONFIG_CONTENT -NotePropertyValue $userInline
        [IO.File]::WriteAllText($serviceFile, (ConvertTo-Json $cfg -Depth 5))
        $failureMessage = ''
        try { & $modeScript on | Out-Null } catch { $failureMessage = $_.Exception.Message }
        Assert-That ($failureMessage -match 'OPENCODE_CONFIG_CONTENT') 'The inline-config conflict was not reported.'
        Assert-That ($testContext.trace.Count -eq 0) 'The incompatible overlay interrupted the service or runtime.'
        Assert-That ((Read-ServiceFile).env.OPENCODE_CONFIG_CONTENT -ceq $userInline) 'The existing inline configuration changed.'
    }

    Test-SwitchCase 'status detects mismatched proxy settings and reports a cold runtime separately' {
        $output = & $modeScript default on
        Assert-That (($output -join ' ') -match 'Tor mode: ON.*Tor proxy: listening') 'A healthy cold runtime was not reported as standby.'
        $cfg = Read-ServiceFile
        $cfg.env.HTTPS_PROXY = 'http://127.0.0.1:12345'
        [IO.File]::WriteAllText($serviceFile, (ConvertTo-Json $cfg -Depth 5))
        $testContext.runtimeReady = $false
        $output = & $modeScript status
        Assert-That (($output -join ' ') -match 'Tor mode: INCOMPLETE.*Tor proxy: unavailable') 'Status missed configuration drift or the stopped runtime.'
    }

    Test-SwitchCase 'per-session revert stops the service and restores settings without relaunching it' {
        & $modeScript default off | Out-Null
        & $modeScript on | Out-Null
        $testContext.trace.Clear()
        & $modeScript -Command revert -RevertToken 'current-ticket'
        Assert-That ((Read-ServiceFile).env.HTTPS_PROXY -ceq $proxyBefore) 'Session closure did not restore the previous proxy.'
        Assert-That (-not $testContext.serviceRunning) 'Session closure left the old service running.'
        Assert-That (($testContext.trace -join ',') -eq 'stop') 'Session closure restarted the service or tried to stop its own caller.'
    }

    Test-SwitchCase 'a stale auto-revert cannot undo an enabled mode' {
        & $modeScript default off | Out-Null
        & $modeScript on | Out-Null
        $testContext.trace.Clear()
        & $modeScript -Command revert -RevertToken 'stale-ticket'
        Assert-That ($LASTEXITCODE -eq 3) 'The stale callback did not exit with the expected result.'
        Assert-That ((Read-ServiceFile).env.HTTP_PROXY -ceq 'http://127.0.0.1:12063') 'A stale callback replaced the active proxy.'
        Assert-That ($testContext.trace.Count -eq 0) 'A stale callback interrupted the service.'
    }

    Test-SwitchCase 'the automatic revert caller can retry after lock contention' {
        $modeLock = Join-Path $profileConfig 'tor-web.lock'
        $held = [IO.File]::Open($modeLock, 'OpenOrCreate', 'ReadWrite', 'None')
        try {
            & $modeScript -Command revert -RevertToken 'current-ticket'
            Assert-That ($LASTEXITCODE -eq 4) 'A held switch lock did not report the retryable exit code.'
        } finally { $held.Dispose() }
    }

    Test-SwitchCase 'off recovers the saved settings after TOR_WEB_DATA_DIR drifts' {
        & $modeScript on | Out-Null
        $cfg = Read-ServiceFile
        $cfg.env.TOR_WEB_DATA_DIR = Join-Path $testRoot 'wrong-data'
        [IO.File]::WriteAllText($serviceFile, (ConvertTo-Json $cfg -Depth 5))
        try {
            $env:TOR_WEB_DATA_DIR = $null
            & $modeScript off | Out-Null
            Assert-That ((Read-ServiceFile).env.HTTPS_PROXY -ceq $proxyBefore) 'Off lost the previous proxy after the runtime data directory changed.'
            Assert-That ($testContext.offData -ceq $dataDir) 'Off used the changed runtime path instead of the active path.'
        } finally { $env:TOR_WEB_DATA_DIR = $dataDir }
    }

    Test-SwitchCase 'an interrupted activation restarts the service even when its saved settings already match' {
        & $modeScript on | Out-Null
        $journalPath = Join-Path $profileConfig 'tor-web-mode.json'
        $record = Get-Content -Raw -LiteralPath $journalPath | ConvertFrom-Json
        $record | Add-Member -NotePropertyName phase -NotePropertyValue 'enabling' -Force
        $record | Add-Member -NotePropertyName wasRunning -NotePropertyValue $true -Force
        [IO.File]::WriteAllText($journalPath, (ConvertTo-Json $record -Depth 5))
        $status = & $modeScript status
        Assert-That (($status -join ' ') -match 'Tor mode: INCOMPLETE') 'Pending activation was reported as complete.'
        $testContext.trace.Clear()
        $status = & $modeScript on
        Assert-That ($testContext.trace -contains 'start') 'On skipped restarting the service after interrupted activation.'
        Assert-That (($status -join ' ') -match 'Tor mode: ON') 'On did not mark the recovered switch complete.'
    }

    Test-SwitchCase 'off resumes an interrupted switch and recovers the previously running service' {
        & $modeScript on | Out-Null
        $journalPath = Join-Path $profileConfig 'tor-web-mode.json'
        $record = Get-Content -Raw -LiteralPath $journalPath | ConvertFrom-Json
        $record | Add-Member -NotePropertyName phase -NotePropertyValue 'disabling' -Force
        $record | Add-Member -NotePropertyName wasRunning -NotePropertyValue $true -Force
        [IO.File]::WriteAllText($journalPath, (ConvertTo-Json $record -Depth 5))
        $testContext.serviceRunning = $false
        & $modeScript off | Out-Null
        Assert-That ((Read-ServiceFile).env.HTTPS_PROXY -ceq $proxyBefore) 'Off did not restore the previous proxy.'
        Assert-That $testContext.serviceRunning 'Off did not restart the previously running service.'
        Assert-That (-not (Test-Path -LiteralPath $journalPath)) 'Off left the switch pending.'
    }
} finally {
    foreach ($key in $previousEnvironment.Keys) { [Environment]::SetEnvironmentVariable($key, $previousEnvironment[$key]) }
    $fullTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if ((Test-Path -LiteralPath $testRoot) -and (Resolve-Path -LiteralPath $testRoot).Path.StartsWith($fullTemp + 'tor-web-switch-test-', [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}
if ($failures.Count) { throw "$($failures.Count) mode switch tests failed." }
