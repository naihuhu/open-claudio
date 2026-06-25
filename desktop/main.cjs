// Electron main process — embedded-server desktop wrapper.
//
// Strategy: start the built Express server (dist/server.cjs) on a free localhost
// port, then point a BrowserWindow at http://127.0.0.1:<port>. The renderer loads
// over real HTTP from the same origin that serves /api, so every existing relative
// `fetch("/api/...")` in the web app keeps working unchanged.
//
// Two runtimes depending on context:
//   • dev (npm run desktop): spawn the *system* node. node_modules natives
//     (better-sqlite3) are compiled for system Node's ABI, and `npm run dev`/
//     `npm start` keep working off the same build.
//   • packaged (app.isPackaged): run inside Electron's own Node via utilityProcess.
//     electron-builder rebuilds natives for Electron's ABI at pack time
//     (@electron/rebuild), so no separate node binary is needed on the user's box.
const { app, BrowserWindow, utilityProcess } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const net = require('net');
const http = require('http');

// Where dist/ + read-only assets live. In dev that's the project root; once
// packaged, assets sit inside app.asar (app.getAppPath()), which cwd can't point
// to — the server reads them via CLAUDIO_APP_ROOT instead.
const ASSET_ROOT = app.isPackaged ? app.getAppPath() : path.join(__dirname, '..');
const SERVER_ENTRY = path.join(ASSET_ROOT, 'dist', 'server.cjs');

let serverProc = null;
let mainWindow = null;

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function waitForServer(port, attempt = 0) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1000 }, (res) => {
      res.destroy();
      resolve();
    });
    req.on('error', () => {
      if (attempt > 100) return reject(new Error('Embedded server did not become ready in time'));
      setTimeout(() => waitForServer(port, attempt + 1).then(resolve, reject), 200);
    });
  });
}

function startServer(port) {
  const env = {
    ...process.env,
    NODE_ENV: 'production', // serve built assets from dist/ (no Vite dev server)
    PORT: String(port),
    HOST: '127.0.0.1', // localhost only — single-user desktop app
  };

  if (app.isPackaged) {
    // Run in Electron's Node runtime; natives were rebuilt for this ABI at pack time.
    // Assets live in app.asar (cwd can't point there) — tell the server via env.
    env.CLAUDIO_APP_ROOT = ASSET_ROOT;
    serverProc = utilityProcess.fork(SERVER_ENTRY, [], {
      env,
      stdio: 'inherit',
      serviceName: 'claudio-server',
    });
  } else {
    // Dev: spawn the system node so the system-ABI native build stays valid and
    // `npm run dev` / `npm start` keep working. Override with CLAUDIO_NODE.
    serverProc = spawn(process.env.CLAUDIO_NODE || 'node', [SERVER_ENTRY], {
      cwd: ASSET_ROOT,
      env,
      stdio: 'inherit',
    });
  }

  serverProc.on('exit', (code) => {
    if (code && !app.isQuitting) console.error(`Embedded server exited with code ${code}`);
  });
  return waitForServer(port);
}

async function createWindow() {
  const port = await getFreePort();
  await startServer(port);

  mainWindow = new BrowserWindow({
    width: 520, // matches the app's max-w-[520px] terminal panel
    height: 715, // 675 content area + 40px title strip
    minWidth: 420,
    minHeight: 600,
    backgroundColor: '#080612', // app's default (dark) theme bg — the title bar blends in
    title: '', // no title text on the bar
    titleBarStyle: 'hidden', // macOS: drop the title bar chrome, keep traffic lights
    trafficLightPosition: { x: 13, y: 14 }, // center the macOS controls in the h-10 (40px) title strip
    titleBarOverlay: { color: '#080612', symbolColor: '#cbd5e1', height: 40 }, // Windows/Linux controls
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Keep rAF/timers running when the window is minimized or occluded. The DJ duck/lift
      // (rampMusicVolume) is requestAnimationFrame-driven; with the default throttling it stalls
      // in the background and the 渐弱渐强 never lands. Music keeps playing in the background, so
      // its fades must too.
      backgroundThrottling: false,
    },
  });

  await mainWindow.loadURL(`http://127.0.0.1:${port}`);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app
  .whenReady()
  .then(createWindow)
  .catch((err) => {
    console.error('Failed to start desktop app:', err);
    app.quit();
  });

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  app.isQuitting = true;
});
app.on('quit', () => {
  if (serverProc && !serverProc.killed) serverProc.kill();
});
