//
// secrets.ts — Electron side of the team-key scheme (see shared/crypto.ts for
// the threat model and why this design is the one that actually works).
//
// The key lives in the OS credential store, never on disk in the clear and
// never in the repo:
//   macOS   → Keychain, via Electron safeStorage
//   Windows → DPAPI, scoped to the Windows user account
//
// safeStorage produces a blob only the logged-in OS user can decrypt, so a
// stolen copy of the userData folder is useless on another machine. That is
// also why "remember the key" is safe to do by default here, where writing the
// passphrase to a plain file would not be.
//

import { app, safeStorage } from 'electron';
import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

import {
  decryptSecrets,
  keyFingerprint,
  WrongKeyError,
  type SecretBundle,
  type Secrets,
} from '../shared/crypto.ts';

export type SecretsStatus = {
  unlocked: boolean;
  /** No bundle shipped at all — the app still runs, just without imagery. */
  bundleMissing: boolean;
  /** OS credential store unavailable; the key will be asked for every launch. */
  canRemember: boolean;
  fingerprint: string | null;
};

let cached: Secrets | null = null;
let cachedFingerprint: string | null = null;

/** Packaged builds get the bundle via electron-builder `extraResources`;
 *  `npm start` reads it straight out of the source tree. */
function bundlePath(): string {
  const packaged = join(process.resourcesPath ?? '', 'secrets', 'secrets.enc.json');
  if (app.isPackaged && existsSync(packaged)) return packaged;
  return join(app.getAppPath(), 'secrets', 'secrets.enc.json');
}

function keyPath(): string {
  return join(app.getPath('userData'), 'team-key.bin');
}

async function loadBundle(): Promise<SecretBundle | null> {
  try {
    return JSON.parse(await readFile(bundlePath(), 'utf8')) as SecretBundle;
  } catch {
    return null;
  }
}

async function rememberKey(passphrase: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) return;
  const path = keyPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, safeStorage.encryptString(passphrase), { mode: 0o600 });
}

async function recallKey(): Promise<string | null> {
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(await readFile(keyPath()));
  } catch {
    // Wrong OS user, corrupt blob, or nothing stored yet — all mean "ask again".
    return null;
  }
}

/** Try the stored key on launch. Never throws: a locked app is a working app
 *  with the satellite layer unavailable, not a crash. */
export async function unlockFromStore(): Promise<SecretsStatus> {
  const bundle = await loadBundle();
  if (!bundle) return status(true);
  const key = await recallKey();
  if (key === null) return status(false);
  try {
    cached = decryptSecrets(bundle, key);
    cachedFingerprint = keyFingerprint(bundle, key);
  } catch {
    // The shipped bundle was re-keyed since this machine stored its key.
    await forget();
  }
  return status(false);
}

export async function unlock(
  passphrase: string,
  remember: boolean,
): Promise<{ ok: boolean; error?: string; status: SecretsStatus }> {
  const bundle = await loadBundle();
  if (!bundle) {
    return {
      ok: false,
      error: 'This build ships no secrets bundle.',
      status: status(true),
    };
  }
  try {
    cached = decryptSecrets(bundle, passphrase.trim());
    cachedFingerprint = keyFingerprint(bundle, passphrase.trim());
  } catch (e) {
    const error =
      e instanceof WrongKeyError ? e.message : `Could not read the bundle: ${String(e)}`;
    return { ok: false, error, status: status(false) };
  }
  if (remember) await rememberKey(passphrase.trim());
  return { ok: true, status: status(false) };
}

export async function forget(): Promise<SecretsStatus> {
  cached = null;
  cachedFingerprint = null;
  try {
    await unlink(keyPath());
  } catch {
    /* nothing stored */
  }
  return status(false);
}

function status(bundleMissing: boolean): SecretsStatus {
  return {
    unlocked: cached !== null,
    bundleMissing,
    canRemember: safeStorage.isEncryptionAvailable(),
    fingerprint: cachedFingerprint,
  };
}

export async function currentStatus(): Promise<SecretsStatus> {
  return status((await loadBundle()) === null);
}

/** Secrets never cross into the renderer. Main-process code asks for what it
 *  needs at the point of use, so the token cannot end up in a DOM attribute or
 *  a devtools inspection. */
export function mapboxToken(): string | null {
  return cached?.mapboxToken ?? null;
}
