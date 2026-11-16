# Tor mode web tools

- Search: inside `execute`, call `await tools["tor-web"].tor_search({ query: "...", max_results: 5 })`.
- Fetch: call `await tools["tor-web"].tor_fetch({ url: "https://..." })` for public web pages or .onion addresses. Prefer HTTPS for public websites.
- Check the Tor exit: call `await tools["tor-web"].tor_status({})`.
- The shell tool, built-in web tools and browser tool are blocked in this mode. Use `tor_search` and `tor_fetch` for web access.
- Keep personal details, API keys and other secrets out of search queries and URL parameters.
