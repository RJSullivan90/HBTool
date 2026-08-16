//
// crypto.test.ts — the team-key scheme.
//
// The assertions here are the security claims stated as code. If one of these
// ever fails, the public repo is no longer safe to publish to.
//

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decryptSecrets,
  encryptSecrets,
  keyFingerprint,
  sameFingerprint,
  WrongKeyError,
  type SecretBundle,
} from '../src/shared/crypto.ts';

const KEY = 'correct horse battery staple';
const SECRETS = { mapboxToken: 'pk.eyJ1IjoiZXhhbXBsZSJ9.abc123' };

test('round-trips under the right key', () => {
  const bundle = encryptSecrets(SECRETS, KEY);
  assert.deepEqual(decryptSecrets(bundle, KEY), SECRETS);
});

test('the wrong key is rejected, not silently mis-decrypted', () => {
  const bundle = encryptSecrets(SECRETS, KEY);
  assert.throws(() => decryptSecrets(bundle, 'wrong key'), WrongKeyError);
});

test('the published bundle contains no trace of the plaintext', () => {
  // This is the whole point of the exercise: what lands in the public repo must
  // not carry the token in any recoverable form.
  const bundle = encryptSecrets(SECRETS, KEY);
  const serialised = JSON.stringify(bundle);
  assert.ok(!serialised.includes(SECRETS.mapboxToken));
  assert.ok(!serialised.includes('pk.'));
  assert.ok(!serialised.includes(KEY));
  // And nothing base64-decodes back to it either.
  const decoded = Buffer.from(bundle.ciphertext, 'base64').toString('latin1');
  assert.ok(!decoded.includes('pk.'));
});

test('the same secret encrypts differently every time', () => {
  // Fresh salt and IV per call. Identical ciphertext across releases would leak
  // that the token had NOT been rotated, and would reuse an IV under one key.
  const a = encryptSecrets(SECRETS, KEY);
  const b = encryptSecrets(SECRETS, KEY);
  assert.notEqual(a.ciphertext, b.ciphertext);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.kdf.salt, b.kdf.salt);
});

test('tampering with the ciphertext is detected', () => {
  const bundle = encryptSecrets(SECRETS, KEY);
  const raw = Buffer.from(bundle.ciphertext, 'base64');
  raw[0] ^= 0xff;
  const tampered: SecretBundle = { ...bundle, ciphertext: raw.toString('base64') };
  assert.throws(() => decryptSecrets(tampered, KEY), WrongKeyError);
});

test('rotating the token keeps the same team key working', () => {
  // The operational promise: re-encrypt, publish, and nobody re-types anything.
  const rotated = encryptSecrets({ mapboxToken: 'pk.rotated' }, KEY);
  assert.equal(decryptSecrets(rotated, KEY).mapboxToken, 'pk.rotated');
});

test('fingerprint identifies a key without revealing it', () => {
  const bundle = encryptSecrets(SECRETS, KEY);
  const fp = keyFingerprint(bundle, KEY);
  assert.match(fp, /^[0-9A-F]{4}$/);
  assert.equal(keyFingerprint(bundle, KEY), fp);
  assert.notEqual(keyFingerprint(bundle, 'other key'), fp);
  assert.ok(!KEY.includes(fp));
  assert.ok(sameFingerprint(fp, keyFingerprint(bundle, KEY)));
  assert.ok(!sameFingerprint(fp, '0000'));
});

test('an unknown bundle version is refused rather than guessed at', () => {
  const bundle = { ...encryptSecrets(SECRETS, KEY), version: 2 as 1 };
  assert.throws(() => decryptSecrets(bundle, KEY), /Unsupported secret bundle version/);
});
