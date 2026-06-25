# Desktop (Electron)

Thin Electron shell that runs the app as a native desktop window.

## How it works

`main.cjs` starts the built Express server (`dist/server.cjs`) on a free
localhost port, then loads `http://127.0.0.1:<port>` in a `BrowserWindow`.
Because the window loads over real HTTP from the same origin that serves
`/api`, the web app's relative `fetch("/api/...")` calls keep working with no
changes — the desktop build behaves like the browser build.

```
Electron main ──start──> dist/server.cjs  (Express, NODE_ENV=production)
       │                        │
       └── BrowserWindow ──HTTP──┘  http://127.0.0.1:<port>
```

## Two runtimes (dev vs packaged)

The server depends on a native module (`better-sqlite3`), which must match the
ABI of whatever Node runs it. So how the server is launched differs:

| Context | Launch | Native ABI |
|---|---|---|
| **dev** (`npm run desktop`) | `spawn('node', …)` — system Node | system Node's ABI (what `npm install` built) |
| **packaged** (`app.isPackaged`) | `utilityProcess.fork(…)` — Electron's Node | Electron's ABI (rebuilt at pack time) |

This keeps `npm run dev` / `npm start` working off the same `node_modules`,
while the shipped app needs no system Node installed.

Asset paths: when packaged, `dist/` and `taste-profile-generation.md` live
inside `app.asar`, where `process.cwd()` can't point. `main.cjs` passes
`CLAUDIO_APP_ROOT` (= `app.getAppPath()`) and the server resolves read-only
assets from there. Writable user data still lives in `~/.claudio`
(`CLAUDIO_DIR`).

## Run (dev)

```bash
npm run desktop      # builds web + server, then launches Electron
```

The server reads `.env` from the project root (same as `npm start`).

## Package

```bash
npm run pack         # build + electron-builder --dir → release/ (unpacked .app, fast)
npm run dist         # build + full installers (dmg/zip, nsis, AppImage) → release/
```

Config lives in `package.json` → `build` (electron-builder). At pack time
electron-builder runs `@electron/rebuild` to compile `better-sqlite3` for
Electron's ABI, and `asarUnpack` keeps the `.node` binary outside the asar so it
can be `dlopen`ed.

### ⚠️ After packaging, restore the dev build

`electron-builder` rebuilds `better-sqlite3` in `node_modules` for **Electron's**
ABI. That breaks the system-Node paths (`npm run dev` / `npm start` /
`npm run desktop`) until you rebuild it back:

```bash
npm rebuild better-sqlite3      # restore system-Node ABI for dev
```

(This back-and-forth is the cost of sharing one `node_modules`. A future
cleanup is to split desktop into its own workspace package.)

## Still TODO for a shippable app

- **Secrets**: `.env` is intentionally *not* bundled. A real build needs an
  in-app settings screen or a packaged default config for API keys.
- **Code signing / notarization**: required for macOS (Gatekeeper) and Windows
  (SmartScreen) before distributing.
- **Auto-update**: e.g. `electron-updater`.
- **Packaged path not yet run-verified** — the dev path is. Run `npm run pack`
  and launch `release/**/Claudio.app` to validate the asar/utilityProcess path.
