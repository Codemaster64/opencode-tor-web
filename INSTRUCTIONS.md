# Internet access goes through Tor

The user wants maximum anonymity. All internet access in this setup goes through the Tor network.

- Web search: inside the `execute` tool, call `await tools["tor-web"].tor_search({ query: "...", max_results: 5 })`.
- Reading a page, API or file from a URL (including .onion): `await tools["tor-web"].tor_fetch({ url: "..." })`
  (returns readable text), or plain `fetch(url)` inside `execute`, which is also routed through Tor.
- To confirm traffic leaves via Tor: `await tools["tor-web"].tor_status({})`.
- Only https:// works; plain http:// URLs are refused by the Tor proxy (use https:// or a .onion address).

Prefer those tools over the shell. Shell tools that honor HTTPS_PROXY (curl, PowerShell 7 Invoke-WebRequest, python,
pip, npm, node fetch, git over https) are also routed through Tor, but never use raw sockets, ssh, DNS lookups
(nslookup, Resolve-DnsName), ping or anything else that connects directly: that would expose the user's real IP.
Never put the user's name, email or other personal details into searches or requests.
