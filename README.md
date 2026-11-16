# opencode-tor-web

Route [opencode](https://opencode.ai)'s internet traffic through **Tor**: web search, page fetches, the agent's
Code Mode `fetch()`, shell tools, the model list and cloud model gateways. Local models stay local. One command
switches it on and off, and opencode's own web tools work normally when it is off.

Windows. Zero npm dependencies. Uses the `tor.exe` that ships with Tor Browser.

```text
                              ┌────────────────────── opencode (v2) ──────────────────────┐
  web search / fetch  ───────►│ tor-web MCP tools ── SOCKS5 :9062 ─┐                       │
  Code Mode fetch()   ───────►│ HTTPS_PROXY :9063 ─────────────────┼──► tor.exe ──► Tor ──► internet
  shell: curl, pwsh 7,        │   (tor-web front proxy, starts Tor │    (HTTP CONNECT :9064,│
  python, node, git, pip ────►│    on the first connection)        │     IsolateDestAddr)   │
  model list, cloud APIs ────►│                                    ┘                       │
  local models (localhost) ──►│ direct, never leaves the machine                           │
                              └────────────────────────────────────────────────────────────┘
```

## What it does

- **Tools for the agent:** `tor_search` (Exa's agent search API, with Brave and DuckDuckGo's .onion as fallbacks),
  `tor_fetch` (any https or .onion URL, returned as readable text) and `tor_status` (asks check.torproject.org).
- **Everything else goes through Tor too.** opencode's background service gets `HTTPS_PROXY`, so Code Mode's
  `fetch()` and proxy-aware shell tools (curl, PowerShell 7, Python, Node with `NODE_USE_ENV_PROXY`, git, pip, npm)
  exit via Tor. opencode's own `webfetch`/`websearch` tools are switched off in Tor mode.
- **Fails closed.** If Tor is not running or not reachable, requests error out; nothing falls back to a direct
  connection. DNS is resolved by Tor (hostnames go over SOCKS5 / HTTP CONNECT), so lookups don't leak either.
- **Per-site circuits.** Both Tor ports use `IsolateDestAddr`: different sites get different exits, so they can't link
  your visits to each other by IP.
- **Blends in.** `tor_fetch` sends the installed Tor Browser's exact user agent.
- **No local trail.** Visited hosts are not logged (opt in with `TOR_WEB_LOG_HOSTS=1`).
- **Asks before risky shell commands.** opencode prompts before commands that may connect directly: raw sockets, DNS
  lookups, ping, ssh, `git push/pull/fetch/clone`, `Invoke-WebRequest`, and similar.
- **Tor runs only when needed:** it starts on the first request and stops after 10 idle minutes. Started by hand with
  `tor-web on`, it stays up until `tor-web off`. Either way it stops when opencode closes.

## Commands

| Command | |
|---|---|
| `tor-web on` | Tor mode: opencode reaches the internet only through Tor. Starts Tor now. |
| `tor-web off` | Normal opencode: its own web search and fetch, direct internet. Stops Tor. |
| `tor-web status` | Current mode, the default, and whether Tor is running. |
| `tor-web default on` | Tor mode stays on across opencode starts until `tor-web off` (default). |
| `tor-web default off` | Per session: opencode starts normal; `tor-web on` lasts until opencode closes. |

Switching restarts opencode's background service; open opencode windows reconnect.

## Install

Requirements: Windows, [opencode](https://opencode.ai) v2 (tested with 2.0.31), Node.js 18+ (tested with 24),
PowerShell 7 (`winget install Microsoft.PowerShell`) and [Tor Browser](https://www.torproject.org/download/)
(its `tor.exe` is used; Tor Browser doesn't need to be open).

```powershell
git clone https://github.com/Codemaster64/opencode-tor-web "$HOME\.config\opencode\tor-web"
Add-Content $PROFILE 'function tor-web { & "$HOME\.config\opencode\tor-web\tor-web.ps1" @args }'
. $PROFILE
tor-web on
```

If Tor Browser isn't on your Desktop, point at its `Tor` folder before switching on:
`[Environment]::SetEnvironmentVariable('TOR_WEB_TOR_DIR', 'D:\Tor Browser\Browser\TorBrowser\Tor', 'User')`.

`tor-web on` writes `opencode.tor.json` (from `opencode.tor.template.json`) for your machine and loads it through
`OPENCODE_CONFIG`, so your own `opencode.json` is never edited. Run `tor-web on` again after PowerShell updates
(the Store version of PowerShell lives in a versioned folder).

## How it works

- `server.mjs` is an MCP server (stdio, no dependencies). opencode v2 exposes MCP tools inside **Code Mode**: the
  model calls `tools["tor-web"].tor_search({ query })` from its `execute` tool. (Setting `codemode: false` hides
  them completely in v2.)
- It also listens on `127.0.0.1:9063`, the port opencode's `HTTPS_PROXY` points at. The first connection starts
  `tor.exe` (detached, own data directory, `__OwningControllerProcess` = the opencode service) and the connection is
  spliced onto Tor's HTTP CONNECT port 9064. The tools use Tor's SOCKS port 9062.
- `tor-web.ps1` switches the mode by setting or removing `OPENCODE_CONFIG`, `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`
  and `NODE_USE_ENV_PROXY` on opencode's background service (`opencode service set env`), and sets opencode's shell
  to PowerShell 7, because Windows PowerShell 5.1's `Invoke-WebRequest` ignores the proxy.
- Lifetime bookkeeping lives in `data/`: Tor's pid, whether it was started by hand, the last activity time and
  whether an opencode window has been seen this session.

## Limits

Tor hides **where requests come from**, not what they say:

- The search provider (Exa) sees your search queries, just not your IP.
- Cloud model gateways still know your account through its API key.
- Code Mode's `fetch()` identifies itself as Bun, not as a browser.
- Shell tools that ignore `HTTPS_PROXY` (raw sockets, Windows PowerShell 5.1, ssh, ping) would connect directly.
  opencode asks before the common ones, but that check matches command text and isn't airtight.
- Plain `http://` is refused by Tor's HTTP CONNECT port; use https:// or .onion.
- `opencode run --standalone` doesn't use the background service, so it isn't proxied.
- Small local models (around 9B) are poor at calling Code Mode tools; larger ones (27B) do fine.

This is a convenience layer, not a hardened anonymity system. For high-risk use, use Tor Browser or Tails.

## Tests

```powershell
node selftest.mjs   # proxy port, tor_status, tor_search and tor_fetch all exit via Tor (~10 s)
node idletest.mjs   # lifetime rules with the idle stop cut to 15 s; stops/starts the opencode service (~3 min)
                    # set TOR_WEB_TEST_MODEL (e.g. a local model id) to also test "Tor stops when opencode closes"
```

## Configuration

| Variable | Default | |
|---|---|---|
| `TOR_WEB_TOR_DIR` | `~\Desktop\Tor Browser\Browser\TorBrowser\Tor` | folder with `tor.exe` |
| `TOR_WEB_SOCKS_PORT` | `9062` | SOCKS port; proxy is +1, Tor's HTTP CONNECT +2 |
| `TOR_WEB_IDLE_MINUTES` | `10` | idle stop for automatically started Tor |
| `TOR_WEB_LOG_HOSTS` | off | log each proxied host to opencode's log |

## Uninstall

`tor-web off`, delete the folder and remove the `tor-web` line from your PowerShell profile.

Not affiliated with the Tor Project or opencode.
