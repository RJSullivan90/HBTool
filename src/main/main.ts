//
// main.ts — Electron main process: the window, and the IPC surface.
//
// The renderer is treated as untrusted: context isolation on, node integration
// off, sandbox on. It never sees the Mapbox token and never makes a network
// request itself — it asks main to do the work and gets back plain data. That
// is what keeps a secret out of the DOM.
//

import { app, BrowserWindow, clipboard, ipcMain, shell } from 'electron';
import { join } from 'node:path';

import { fetchAllTFRs, fetchFires, fetchNearestStations } from './net.ts';
import { saveTextFile } from './files.ts';
import type { FireSourceId } from '../shared/fires.ts';
import { currentStatus, forget, unlock, unlockFromStore } from './secrets.ts';
import {
  checkForUpdates,
  currentUpdateState,
  downloadUpdate,
  initUpdater,
  onUpdateStateChange,
  openReleasesPage,
  quitAndInstall,
  RELEASES_URL,
} from './updater.ts';

// __dirname, not import.meta.url: this file is bundled to CommonJS so that the
// preload (which must be CJS) and the main entry share one output format.
declare const __dirname: string;
const here = __dirname;

let win: BrowserWindow | null = null;

function createWindow(): void {
  win = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    title: 'HBTool',
    backgroundColor: '#191314',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(join(here, 'renderer', 'index.html'));

  // Anything trying to open a new window or navigate away goes to the real
  // browser instead — the app shell only ever shows its own page.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });
}

app.whenReady().then(async () => {
  registerIPC();
  createWindow();

  // safeStorage is only usable after ready, so the stored key is tried here
  // rather than at import time.
  const status = await unlockFromStore();
  win?.webContents.send('secrets:changed', status);

  onUpdateStateChange((s) => win?.webContents.send('update:changed', s));
  // A getter, not the window itself: the window is recreated on macOS after all
  // windows close, and the updater must parent its dialogs to whatever is
  // current rather than to a destroyed reference.
  initUpdater(() => win);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function registerIPC(): void {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    releasesURL: RELEASES_URL,
  }));

  ipcMain.handle('secrets:status', () => currentStatus());
  ipcMain.handle('secrets:unlock', (_e, passphrase: string, remember: boolean) =>
    unlock(passphrase, remember),
  );
  ipcMain.handle('secrets:forget', () => forget());

  ipcMain.handle('tfr:fetch', async (_e, refresh: boolean) => {
    try {
      return { ok: true as const, ...(await fetchAllTFRs(refresh)) };
    } catch (e) {
      return { ok: false as const, error: describe(e) };
    }
  });

  ipcMain.handle('tfr:weather', async (_e, lat: number, lon: number) => {
    try {
      return { ok: true as const, stations: await fetchNearestStations(lat, lon) };
    } catch (e) {
      return { ok: false as const, error: describe(e) };
    }
  });

  ipcMain.handle('fires:fetch', async (_e, source: FireSourceId) => {
    try {
      return { ok: true as const, fires: await fetchFires(source) };
    } catch (e) {
      return { ok: false as const, error: describe(e) };
    }
  });

  ipcMain.handle('file:saveKML', (_e, suggestedName: string, contents: string) =>
    saveTextFile(win, suggestedName, contents),
  );

  ipcMain.handle('clipboard:write', (_e, text: string) => {
    clipboard.writeText(text);
  });

  ipcMain.handle('update:state', () => currentUpdateState());
  ipcMain.handle('update:check', () => checkForUpdates(true));
  ipcMain.handle('update:download', () => downloadUpdate());
  ipcMain.handle('update:install', () => quitAndInstall());
  ipcMain.handle('update:releases', () => openReleasesPage());
}

/** Network errors arrive as terse DOM exceptions; say what actually happened. */
function describe(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/timed? ?out|AbortError/i.test(msg)) {
    return 'The request timed out. Check your connection and try again.';
  }
  if (/fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED/i.test(msg)) {
    return 'Could not reach the service. Check your connection and try again.';
  }
  return msg;
}
