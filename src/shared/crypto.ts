//
// crypto.ts — the team-key scheme that lets this repo be PUBLIC.
//
// WHAT THIS PROTECTS AGAINST, precisely: automated scrapers that crawl public
// GitHub for credential patterns. That is the real threat to a Mapbox token —
// it is what burns a free tier overnight. The repo holds only ciphertext, so
// there is nothing for a scraper to lift.
//
// WHAT IT DOES NOT PROTECT AGAINST: anyone you have given the key to. They can
// decrypt the bundle and read the token, by design — they need it to use the
// app. This is access control for a small trusted team, not DRM.
//
// THE RULE THAT MAKES IT WORK: the key is NEVER committed, and NEVER shipped
// inside the built app. It is typed in once per machine by the person using it
// and then held by the OS keychain. If the key were ever baked into the binary,
// this whole file would be theatre — the download would contain both halves and
// the token would fall out under `strings` in seconds.
//
// Rotating the Mapbox token later is a code push: re-encrypt under the SAME
// team key, publish, and every install picks it up on the next auto-update with
// nobody re-typing anything. Rotating the TEAM key is the disruptive one — it
// requires everyone to re-enter, so it is reserved for someone leaving.
//

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

export type SecretBundle = {
  version: 1;
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  cipher: 'aes-256-gcm';
  iv: string;
  tag: string;
  ciphertext: string;
};

/** Secrets carried in the bundle. Add fields here as more are needed — they all
 *  ride under the one team key, so a new secret costs no new distribution. */
export type Secrets = {
  mapboxToken?: string;
};

// N=32768 with r=8 needs ~33 MB, which is over Node's 32 MB scrypt default —
// hence the explicit maxmem. Lowering N to fit the default would weaken the
// derivation for no reason.
const KDF = { name: 'scrypt', N: 32768, r: 8, p: 1 } as const;
const MAXMEM = 64 * 1024 * 1024;
const KEY_LEN = 32;

function deriveKey(passphrase: string, salt: Buffer, kdf: SecretBundle['kdf']): Buffer {
  return scryptSync(passphrase.normalize('NFKC'), salt, KEY_LEN, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: MAXMEM,
  });
}

export function encryptSecrets(secrets: Secrets, passphrase: string): SecretBundle {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt, { ...KDF, salt: '' });
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(secrets), 'utf8'),
    cipher.final(),
  ]);
  return {
    version: 1,
    kdf: { ...KDF, salt: salt.toString('base64') },
    cipher: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

export class WrongKeyError extends Error {
  constructor() {
    super('That key does not match this build.');
    this.name = 'WrongKeyError';
  }
}

/**
 * Decrypts the bundle, or throws WrongKeyError.
 *
 * The GCM auth tag is what verifies the key: a wrong passphrase derives a wrong
 * AES key, the tag check fails, and `final()` throws. There is deliberately no
 * separate "is this key right" check to compare against — that would be a
 * second thing to keep in sync, and the tag already answers it exactly.
 */
export function decryptSecrets(bundle: SecretBundle, passphrase: string): Secrets {
  if (bundle.version !== 1) {
    throw new Error(`Unsupported secret bundle version ${bundle.version}`);
  }
  const salt = Buffer.from(bundle.kdf.salt, 'base64');
  const key = deriveKey(passphrase, salt, bundle.kdf);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(bundle.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(bundle.tag, 'base64'));
  let plain: string;
  try {
    plain = Buffer.concat([
      decipher.update(Buffer.from(bundle.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new WrongKeyError();
  }
  return JSON.parse(plain) as Secrets;
}

/**
 * A short, non-secret fingerprint of a key, safe to show in the UI and to paste
 * into a message: "does yours say 4F2A too?". It is a truncated hash of the
 * bundle's salt plus the passphrase, so it identifies the key without
 * revealing anything usable — reversing it costs the same brute force as
 * attacking the bundle itself, which is what scrypt is there to make expensive.
 */
export function keyFingerprint(bundle: SecretBundle, passphrase: string): string {
  const salt = Buffer.from(bundle.kdf.salt, 'base64');
  const key = deriveKey(passphrase, salt, bundle.kdf);
  return key.subarray(0, 2).toString('hex').toUpperCase();
}

/** Constant-time compare, for anywhere a fingerprint gets checked. */
export function sameFingerprint(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
