//
// updater.ts — auto-update from public GitHub Releases.
//
// THE SIGNING REALITY, because it decides whether this works silently or not:
//
//  * Windows: auto-update works with no certificate. Unsigned installers get a
//    SmartScreen "unrecognised app" warning on first run until the download
//    builds reputation; a code-signing certificate removes it.
//  * macOS: Squirrel.Mac REFUSES to apply an update to an app that is not
//    signed with a valid Developer ID. Ad-hoc signing is not enough. Without a
//    $99/yr Apple Developer account the download succeeds and the install step
//    fails.
//
// So the flow degrades on purpose rather than pretending: when an update cannot
// be applied automatically, the app says a version is available and offers the
// Releases page. Nobody is left silently running an old build believing the
// auto-update worked.
//

import { app, shell } from 'electron';
import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;

export const RELEASES_URL = 'https://github.com/RJSullivan90/HBTool/releases/latest';

export type UpdateState = {
  status: 'idle' | 'checking' | 'available' | 'downloaded' | 'current' | 'manual' | 'error';
  version?: string;
  message?: string;
};

let state: UpdateState = { status: 'idle' };
let onChange: (s: UpdateState) => void = () => {};

export function currentUpdateState(): UpdateState {
  return state;
}

export function onUpdateStateChange(fn: (s: UpdateState) => void): void {
  onChange = fn;
}

function set(next: UpdateState): void {
  state = next;
  onChange(state);
}

export function initUpdater(): void {
  // A dev run has no packaged app to replace, and checking would only produce a
  // confusing error in the console.
  if (!app.isPackaged) {
    set({ status: 'idle', message: 'Updates are checked in packaged builds only.' });
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => set({ status: 'checking' }));
  autoUpdater.on('update-not-available', (info) =>
    set({ status: 'current', version: info?.version }),
  );
  autoUpdater.on('update-available', (info) =>
    set({ status: 'available', version: info?.version }),
  );
  autoUpdater.on('update-downloaded', (info) =>
    set({
      status: 'downloaded',
      version: info?.version,
      message: 'Restart to finish updating.',
    }),
  );
  autoUpdater.on('error', (err) => {
    const text = String(err?.message ?? err);
    // The unsigned-macOS case is expected, not a fault to shout about — turn it
    // into an actionable "download it yourself" rather than a red error.
    const isSignature = /code signature|not signed|Could not get code signature/i.test(text);
    set({
      status: isSignature ? 'manual' : 'error',
      message: isSignature
        ? 'This build is not code-signed, so it cannot update itself. Download the new version manually.'
        : text,
    });
  });

  void checkForUpdates();
  // Once a day is plenty for a tool that is opened per shift.
  setInterval(() => void checkForUpdates(), 24 * 60 * 60 * 1000);
}

export async function checkForUpdates(): Promise<UpdateState> {
  if (!app.isPackaged) return state;
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    set({ status: 'error', message: String(e) });
  }
  return state;
}

export function quitAndInstall(): void {
  autoUpdater.quitAndInstall();
}

export async function openReleasesPage(): Promise<void> {
  await shell.openExternal(RELEASES_URL);
}
