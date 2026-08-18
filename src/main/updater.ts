//
// updater.ts — update checking with explicit user approval.
//
// Flow: check on startup (and daily) → if a newer version exists, ASK before
// downloading → download with progress → ASK before restarting to install.
// Nothing is fetched or applied without the person at the keyboard saying yes.
//
// THE SIGNING REALITY, because it decides whether this can work at all:
//
//  * Windows: works with no certificate. Unsigned installers get a SmartScreen
//    "unrecognised app" warning on first run until the download builds
//    reputation; a code-signing certificate removes it.
//  * macOS: Squirrel.Mac REFUSES to apply an update to an app that is not
//    signed with a valid Developer ID. Ad-hoc signing is not enough. Without a
//    $99/yr Apple Developer account the download succeeds and the install fails.
//
// So the flow degrades on purpose rather than pretending: when an update cannot
// be applied automatically, the dialog offers the Releases page instead. Nobody
// is left running an old build believing the update worked.
//

import { app, dialog, shell, type BrowserWindow } from 'electron';
import electronUpdater from 'electron-updater';

import {
  isSignatureError,
  plainReleaseNotes,
  shouldPromptForVersion,
} from '../shared/updatePolicy.ts';

const { autoUpdater } = electronUpdater;

export const RELEASES_URL = 'https://github.com/RJSullivan90/HBTool/releases/latest';

export type UpdateState = {
  status:
    | 'idle'
    | 'checking'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'current'
    | 'manual'
    | 'error';
  version?: string;
  /** 0-100 while downloading. */
  percent?: number;
  message?: string;
};

let state: UpdateState = { status: 'idle' };
let onChange: (s: UpdateState) => void = () => {};
let getWindow: () => BrowserWindow | null = () => null;

/** Versions the user said "not now" to. Session-only on purpose: persisting a
 *  decline would silently pin someone to an old build forever, while re-asking
 *  on the next daily check would be nagging. A relaunch asks again. */
const declined = new Set<string>();

/** True while a prompt is on screen, so the daily timer cannot stack a second
 *  dialog on top of the first. */
let prompting = false;

/** Whether the in-flight check was started by the user. A manual check reports
 *  "you are up to date"; an automatic one stays silent, because a popup saying
 *  nothing happened is noise. */
let userInitiated = false;

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

async function askToDownload(version: string, notes: string): Promise<boolean> {
  const win = getWindow();
  const detail = [
    `You have ${app.getVersion()}. Version ${version} is available.`,
    notes.length > 0 ? `\n${notes}` : '',
  ]
    .join('')
    .trim();

  const opts = {
    type: 'question' as const,
    buttons: ['Download', 'Not now'],
    defaultId: 0,
    cancelId: 1,
    title: 'Update available',
    message: `HBTool ${version} is available`,
    detail,
  };
  const { response } = win
    ? await dialog.showMessageBox(win, opts)
    : await dialog.showMessageBox(opts);
  return response === 0;
}

async function askToInstall(version: string): Promise<boolean> {
  const win = getWindow();
  const opts = {
    type: 'question' as const,
    buttons: ['Restart now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    title: 'Update ready',
    message: `HBTool ${version} is ready to install`,
    detail:
      'HBTool needs to restart to finish updating. If you choose Later it will ' +
      'install the next time you quit.',
  };
  const { response } = win
    ? await dialog.showMessageBox(win, opts)
    : await dialog.showMessageBox(opts);
  return response === 0;
}

async function offerManualDownload(message: string): Promise<void> {
  const win = getWindow();
  const opts = {
    type: 'info' as const,
    buttons: ['Open download page', 'Not now'],
    defaultId: 0,
    cancelId: 1,
    title: 'Update available',
    message: 'This update has to be installed manually',
    detail: message,
  };
  const { response } = win
    ? await dialog.showMessageBox(win, opts)
    : await dialog.showMessageBox(opts);
  if (response === 0) await shell.openExternal(RELEASES_URL);
}

export function initUpdater(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter;

  // A dev run has no packaged app to replace, and checking would only produce a
  // confusing error in the console.
  if (!app.isPackaged) {
    set({ status: 'idle', message: 'Updates are checked in packaged builds only.' });
    return;
  }

  // Nothing is fetched until the user approves it — that is the whole point of
  // this file.
  autoUpdater.autoDownload = false;
  // If they choose "Later" at the install prompt, apply it on quit rather than
  // discarding a download they already approved.
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => set({ status: 'checking' }));

  autoUpdater.on('update-not-available', (info) => {
    set({ status: 'current', version: info?.version });
    if (userInitiated) {
      const win = getWindow();
      const opts = {
        type: 'info' as const,
        buttons: ['OK'],
        title: 'No update available',
        message: `HBTool ${app.getVersion()} is the latest version.`,
      };
      void (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts));
    }
    userInitiated = false;
  });

  autoUpdater.on('update-available', (info) => {
    const version: string | undefined = info?.version;
    set({ status: 'available', version });
    userInitiated = false;
    if (!shouldPromptForVersion(version, declined, prompting)) return;

    prompting = true;
    void (async () => {
      try {
        const ok = await askToDownload(version!, plainReleaseNotes(info?.releaseNotes));
        if (!ok) {
          declined.add(version!);
          set({ status: 'idle', version, message: `${version} available — not installed.` });
          return;
        }
        set({ status: 'downloading', version, percent: 0 });
        await autoUpdater.downloadUpdate();
      } catch (e) {
        set({ status: 'error', version, message: String(e) });
      } finally {
        prompting = false;
      }
    })();
  });

  autoUpdater.on('download-progress', (p) => {
    set({
      status: 'downloading',
      version: state.version,
      percent: Math.round(p?.percent ?? 0),
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    const version: string = info?.version ?? '';
    set({ status: 'downloaded', version, message: 'Restart to finish updating.' });
    void (async () => {
      if (await askToInstall(version)) autoUpdater.quitAndInstall();
    })();
  });

  autoUpdater.on('error', (err) => {
    const text = String(err?.message ?? err);
    userInitiated = false;
    prompting = false;
    // The unsigned-macOS case is expected, not a fault to shout about — turn it
    // into an actionable "download it yourself" rather than a red error.
    if (isSignatureError(text)) {
      set({
        status: 'manual',
        message:
          'This build is not code-signed, so it cannot update itself. ' +
          'Download the new version manually.',
      });
      void offerManualDownload(
        'This copy of HBTool is not code-signed, so macOS will not let it ' +
          'replace itself. Download the latest version and drag it over the old one.',
      );
      return;
    }
    set({ status: 'error', message: text });
  });

  // Wait for the window to finish loading before the first check, so a dialog
  // cannot appear over a half-drawn window on a cold start.
  const win = getWindow();
  if (win && win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', () => void checkForUpdates(false));
  } else {
    void checkForUpdates(false);
  }
  // Once a day is plenty for a tool opened per shift.
  setInterval(() => void checkForUpdates(false), 24 * 60 * 60 * 1000);
}

/** `manual` true when the user asked, which makes "no update" report itself. */
export async function checkForUpdates(manual = true): Promise<UpdateState> {
  if (!app.isPackaged) return state;
  userInitiated = manual;
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    set({ status: 'error', message: String(e) });
  }
  return state;
}

/** Approve the download from the UI rather than the dialog. */
export async function downloadUpdate(): Promise<UpdateState> {
  if (!app.isPackaged) return state;
  try {
    if (state.version) declined.delete(state.version);
    set({ status: 'downloading', version: state.version, percent: 0 });
    await autoUpdater.downloadUpdate();
  } catch (e) {
    set({ status: 'error', version: state.version, message: String(e) });
  }
  return state;
}

export function quitAndInstall(): void {
  autoUpdater.quitAndInstall();
}

export async function openReleasesPage(): Promise<void> {
  await shell.openExternal(RELEASES_URL);
}
