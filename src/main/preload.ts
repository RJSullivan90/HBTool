//
// preload.ts — the only bridge between the renderer and the main process.
//
// Every exposed function is a named, fixed-shape call. Nothing here forwards an
// arbitrary channel name from the renderer, because that would hand a
// compromised page the whole IPC surface.
//

import { contextBridge, ipcRenderer } from 'electron';

const api = {
  appInfo: () => ipcRenderer.invoke('app:info'),

  secretsStatus: () => ipcRenderer.invoke('secrets:status'),
  unlock: (passphrase: string, remember: boolean) =>
    ipcRenderer.invoke('secrets:unlock', passphrase, remember),
  forgetKey: () => ipcRenderer.invoke('secrets:forget'),
  onSecretsChanged: (fn: (status: unknown) => void) => {
    ipcRenderer.on('secrets:changed', (_e, status) => fn(status));
  },

  fetchTFRs: (refresh: boolean) => ipcRenderer.invoke('tfr:fetch', refresh),
  fetchWeather: (lat: number, lon: number) => ipcRenderer.invoke('tfr:weather', lat, lon),

  fetchFires: (source: string) => ipcRenderer.invoke('fires:fetch', source),
  saveKML: (suggestedName: string, contents: string) =>
    ipcRenderer.invoke('file:saveKML', suggestedName, contents),

  copy: (text: string) => ipcRenderer.invoke('clipboard:write', text),

  updateState: () => ipcRenderer.invoke('update:state'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  openReleases: () => ipcRenderer.invoke('update:releases'),
  onUpdateChanged: (fn: (state: unknown) => void) => {
    ipcRenderer.on('update:changed', (_e, state) => fn(state));
  },
};

contextBridge.exposeInMainWorld('hbtool', api);

export type HBToolAPI = typeof api;
