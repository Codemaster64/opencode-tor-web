# opencode-tor-web

Use DuckDuckGo search and page fetch through Tor in [OpenCode](https://opencode.ai) on Windows. The OpenCode background service also gets an HTTP CONNECT proxy for proxy-aware HTTPS requests, including Code Mode `fetch()`. Loopback model endpoints remain reachable directly.

Tor mode blocks the agent's shell, browser, and built-in web tools. Use `tor_search`, `tor_fetch`, and `tor_status` in Code Mode. This avoids depending on the environment of a previously opened terminal session.

## Install

Requirements: Windows, OpenCode v2 (tested with 2.0.31), Node.js 24 or later, PowerShell, and [Tor Browser](https://www.torproject.org/download/). Tor Browser can stay closed. Its bundled `tor.exe` runs with separate data.

```powershell
git clone https://github.com/Codemaster64/opencode-tor-web "$HOME\.config\opencode\tor-web"
New-Item -ItemType Directory -Force (Split-Path $PROFILE) | Out-Null
Add-Content $PROFILE 'function tor-web { & "$HOME\.config\opencode\tor-web\tor-web.ps1" @args }'
. $PROFILE
tor-web on
```

If Tor Browser is installed elsewhere, set `TOR_WEB_TOR_DIR` to its `Browser\TorBrowser\Tor` directory in your current PowerShell session before running `tor-web on`. Use a user environment variable to remember it across terminals.

| Command | Behavior |
|---|---|
| `tor-web on` | Verifies that the local proxy and Tor can start, then enables Tor mode. |
| `tor-web off` | Restores the prior OpenCode service settings and stops this installation's Tor runtime. |
| `tor-web status` | Checks the effective Tor mode settings separately from the runtime and Tor connection status. |
| `tor-web default on` | Keep Tor mode enabled across OpenCode launches. |
| `tor-web default off` | Restore the previous settings after the last Tor MCP session disconnects and active requests finish. |

If OpenCode was running before a switch, the script starts it again with the new settings. Your normal configuration file stays in place. Keep the same installation directory and OpenCode profile when turning the mode off.

If you are updating an older installation, run `tor-web off` with the old version before replacing its files so it releases the original Tor ports.

## Search and fetch

Inside the agent's `execute` tool:

```javascript
const results = await tools["tor-web"].tor_search({ query: "Tor Project", max_results: 5 })
return results
```

Use `tor_fetch({ url: "https://example.com/" })` for readable page text and `tor_status({})` to check Tor exit status. Search uses DuckDuckGo's HTML service through Tor. The DuckDuckGo onion service is preferred, and the public DuckDuckGo HTML service is also reached through Tor when used. An access challenge stops the DuckDuckGo request. The tool can then use Exa’s hosted search MCP over Tor if you explicitly enable that fallback. No Exa API key is required, and Exa receives the search query when it is used.

```powershell
tor-web off
$env:TOR_WEB_SEARCH_FALLBACK = 'exa'
tor-web on
```

Set `TOR_WEB_SEARCH_FALLBACK` to `off` and switch off and on again to return to DuckDuckGo only. Configure it as a user environment variable if you need it across terminals.

## Routing and limits

- The MCP tools use the managed Tor SOCKS listener. Proxy-aware OpenCode service requests use a separate HTTP CONNECT listener on loopback. A missing proxy or Tor connection produces a request error on these paths.
- This is an application proxy, with coverage limited to the above paths. OpenCode started in standalone mode, external tools, custom plugins, other MCP integrations and programs that ignore proxy settings have their own network behavior. Tor mode does not install operating system network isolation.
- HTTPS connections through the HTTP CONNECT proxy are supported. The MCP fetch tool handles public HTTP(S) and onion URLs over SOCKS. Prefer HTTPS for public services.
- Tor changes the network route. DuckDuckGo sees the query, API providers can recognize an account, and OpenCode can record tool calls and results in session history. This setup does not provide Tor Browser's fingerprinting protections or guarantee unique exit IPs per destination.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `TOR_WEB_TOR_DIR` | `~\Desktop\Tor Browser\Browser\TorBrowser\Tor` | Folder containing Tor Browser's `tor.exe`. |
| `TOR_WEB_SOCKS_PORT` | `9062` | Loopback SOCKS port. The front proxy uses port +1 and Tor's HTTP tunnel uses +2. |
| `TOR_WEB_IDLE_MINUTES` | `10` | Idle timeout for automatically started Tor. |
| `TOR_WEB_SEARCH_FALLBACK` | `off` | Set to `exa` to use Exa after a DuckDuckGo challenge, rate limit or availability failure. |
| `TOR_WEB_LOG_HOSTS` | unset | Set to `1` to enable destination logging in `data/proxy.log`. |

## Startup diagnostics

`tor-web on` allows up to two minutes without Tor bootstrap progress and has a three-minute total limit. If progress stalls, the error lists the last bootstrap stage reached. `tor-web status` also shows the bootstrap stage during on-demand starts after Tor mode is enabled. The previous OpenCode service settings are kept if startup fails.

## Tests

```powershell
node --test            # offline JavaScript regression tests
.\mode-switch.test.ps1 # offline Windows switch regression tests
node selftest.mjs    # real OpenCode + Tor + DuckDuckGo in a temporary Windows profile
```

The smoke test uses a loopback model fixture to invoke the tools through OpenCode. It requires a working Tor connection. Set `TOR_WEB_TEST_OPENCODE` to the OpenCode executable if it was installed outside the default npm location.

## Uninstall

Run `tor-web off`, remove the `tor-web` profile function, and delete the installation folder.

This project is independent of the Tor Project, DuckDuckGo, and OpenCode.
