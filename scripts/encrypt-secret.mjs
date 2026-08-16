//
// encrypt-secret.mjs — produce secrets/secrets.enc.json for the public repo.
//
//   npm run encrypt-secret
//
// Asks for the team key and the secret values, writes the encrypted bundle, and
// prints the key fingerprint so you can confirm your teammates unlocked the
// right one. Nothing secret is echoed, logged, or written anywhere but the
// bundle — and the bundle is safe to commit, which is the entire point.
//
// Run this again to rotate the Mapbox token: same team key, new token, commit,
// release. Every install picks it up on the next update with nobody re-typing.
//

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encryptSecrets, decryptSecrets, keyFingerprint } from '../src/shared/crypto.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outPath = join(root, 'secrets', 'secrets.enc.json');

const ETX = ''; // Ctrl-C
const BACKSPACE = new Set(['', '\b']);

/** Reads a line without echoing it, so a key never lands in the terminal
 *  scrollback or a screen share. */
async function secretPrompt(question) {
  if (!process.stdin.isTTY) {
    throw new Error('encrypt-secret needs an interactive terminal.');
  }
  process.stdout.write(question);
  const wasRaw = process.stdin.isRaw ?? false;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let value = '';
  await new Promise((resolve) => {
    const onData = (buf) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          process.stdin.off('data', onData);
          process.stdin.setRawMode(wasRaw);
          process.stdin.pause();
          process.stdout.write('\n');
          resolve();
          return;
        }
        if (ch === ETX) {
          process.stdin.setRawMode(wasRaw);
          process.stdout.write('\n');
          process.exit(130);
        }
        if (BACKSPACE.has(ch)) value = value.slice(0, -1);
        else value += ch;
      }
    };
    process.stdin.on('data', onData);
  });
  return value;
}

async function existingSecrets(key) {
  try {
    const bundle = JSON.parse(await readFile(outPath, 'utf8'));
    return decryptSecrets(bundle, key);
  } catch {
    return null;
  }
}

const key = (await secretPrompt('Team key: ')).trim();
if (key.length < 8) {
  console.error('Refusing: use a team key of at least 8 characters.');
  process.exit(1);
}
const confirm = (await secretPrompt('Confirm team key: ')).trim();
if (key !== confirm) {
  console.error('The two keys do not match.');
  process.exit(1);
}

const previous = await existingSecrets(key);
if (previous) {
  console.log('Existing bundle opened with this key — a blank value keeps what is there.');
}

const token = (await secretPrompt('Mapbox token (pk....): ')).trim();
const mapboxToken = token.length > 0 ? token : previous?.mapboxToken;

if (!mapboxToken) {
  console.error('No Mapbox token given and none to carry forward.');
  process.exit(1);
}
if (!mapboxToken.startsWith('pk.')) {
  console.error('Refusing: that is not a public "pk." token. A secret "sk." token must');
  console.error('never be distributed to clients, encrypted or not.');
  process.exit(1);
}

const bundle = encryptSecrets({ mapboxToken }, key);
await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, JSON.stringify(bundle, null, 2) + '\n');

console.log(`\nWrote ${outPath}`);
console.log(`Key fingerprint: ${keyFingerprint(bundle, key)}`);
console.log('\nThat fingerprint is not secret — share it so teammates can confirm');
console.log('they unlocked the right key. Commit the bundle; never the key.');
