// Preload bridge (runs before the renderer, with Node access).
//
// The web UI talks to the embedded server over HTTP, so it already works exactly
// like the browser build — nothing native is required yet. Expose a small flag so
// the frontend can detect it's running inside the desktop shell, and add real
// contextBridge APIs here (tray, native dialogs, OS media keys…) as needed.
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  platform: process.platform,
});
