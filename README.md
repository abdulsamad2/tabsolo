# TabSolo (beta)

**One browser. Every tab its own session.**

TabSolo is a desktop browser for Windows and macOS where every tab has its own cookies, storage
and logins, and its own IP address. Run dozens of accounts side by side, swap a tab to a fresh IP
without logging out, and keep each profile's session exactly where you left it.

[**Download**](https://github.com/abdulsamad2/tabsolo/releases/latest) ·
[Website](https://tabsolo-site.vercel.app)

---

## Multi-session features

| | |
|---|---|
| **A session per tab** | Each tab runs in its own Chromium session: separate cookies, local storage, IndexedDB, cache and logins. Open up to 50 isolated tabs at launch. |
| **Shared mode** | Prefer one identity? Launch with a single shared session for every tab. |
| **An IP per tab** | Every tab connects through its own proxy, so each session has its own IP address. |
| **New IP** | On a profile tab, moves the session to a fresh IP and keeps you signed in. On a plain tab, starts a clean session on the next IP and reloads the same page. **New IPs: all** does every tab at once. |
| **Proxy ↔ local IP** | Switch a tab between your own connection and a proxy without reloading or losing its session. You can also launch every tab on your local IP and switch to a proxy only when needed. |
| **Regions** | Tag proxies with a region (`us`, `ca`, `gb`…) or use a gateway with `{country}`, then pick a region per tab. |
| **Profiles** | A saved profile owns a persistent session and keeps a proxy from your start-screen pool pinned to it, so its IP stays the same. Its cookies and logins survive restarts, and every tab you open with it shares them. **🧹 Clear all** wipes every tab and account session (deleted from disk), gives each a new IP and opens the home page. |
| **Duplicate tab** | The same page in a brand-new session, or in the same profile's session for profile tabs. |
| **Pop-ups stay put** | Windows a site opens (sign-in, payment) stay in the opening tab's session and IP. |
| **Private by default** | Plain tab sessions live in memory and disappear when you quit. |

## Proxies

Pick a source on the launch screen:

- **Proxy list:** one per line. Each tab takes the next proxy.
  ```text
  host:port
  host:port:user:pass
  user:pass@host:port
  http://host:port
  socks5://host:port
  us host:port:user:pass      # region tag
  ```
- **Rotating gateway:** host, port, password and a username template. `{session}` becomes a sticky
  id per tab (New IP draws another); `{country}` follows the tab's region, for example
  `user-country-{country}-session-{session}`.
- **Remote list:** a URL that returns a proxy list (optional Bearer token), loaded at launch.
- **Direct:** no proxy; tabs still get separate sessions on your own IP.

HTTP(S) proxies support usernames and passwords. SOCKS5 proxies work without authentication
(Chromium can't authenticate to SOCKS5).

## Install

Download the latest build from [Releases](https://github.com/abdulsamad2/tabsolo/releases/latest):

- **Windows:** `TabSolo-Setup-<version>.exe` (installer) or `TabSolo-<version>.exe` (portable). If
  SmartScreen warns, choose *More info → Run anyway*.
- **macOS:** `TabSolo-<version>-arm64.dmg` (Apple silicon) or `TabSolo-<version>.dmg` (Intel). The
  build isn't notarised yet: the first time, open TabSolo, close the warning, then go to System Settings → Privacy & Security and click *Open Anyway*.

The Windows version updates itself (on launch and every two hours, installed on restart). On macOS,
download new versions from Releases until the build is signed.

## Development

Requires Node.js 20+.

```bash
npm install
npm start            # run from source
npm test             # unit tests
npm run test:e2e     # Electron end-to-end tests
```

Optional settings for development go in `.env.local`, which is never committed or packaged.
[.env.example](.env.example) lists them.

### Building and releasing

```bash
npm run dist:mac     # local macOS build into dist/
npm run dist:win     # local Windows build into dist/
```

To publish an update that installed apps pick up:

1. Bump `version` in `package.json`, then commit and push.
2. Put a GitHub token with `repo` scope in `.env.local` as `GH_TOKEN=…`.
3. Run `npm run release`. It creates a draft release, uploads the macOS and Windows builds and update
   manifests, then publishes the release.

### Website

The website (https://tabsolo-site.vercel.app) is a separate Next.js project, deployed on Vercel.
