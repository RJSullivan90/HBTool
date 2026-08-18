//
// updatePolicy.test.ts — when the update prompt is allowed to interrupt.
//
// These rules decide whether a person gets a dialog in their face, so the
// nagging behaviour is worth pinning down rather than discovering in the field.
//

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isSignatureError,
  plainReleaseNotes,
  shouldPromptForVersion,
} from '../src/shared/updatePolicy.ts';

test('prompts for a fresh version', () => {
  assert.equal(shouldPromptForVersion('0.2.0', new Set(), false), true);
});

test('does not re-prompt for a version already declined', () => {
  // Otherwise the daily check nags every day for something the user refused.
  assert.equal(shouldPromptForVersion('0.2.0', new Set(['0.2.0']), false), false);
});

test('a decline is version-specific, so the NEXT release still asks', () => {
  // Declining 0.2.0 must not silently pin someone to 0.1.0 forever.
  assert.equal(shouldPromptForVersion('0.3.0', new Set(['0.2.0']), false), true);
});

test('never stacks a second dialog on top of one already open', () => {
  // The daily timer can fire while the first prompt is still on screen.
  assert.equal(shouldPromptForVersion('0.2.0', new Set(), true), false);
});

test('no version means no prompt', () => {
  assert.equal(shouldPromptForVersion(undefined, new Set(), false), false);
  assert.equal(shouldPromptForVersion('', new Set(), false), false);
});

test('release notes are flattened out of HTML', () => {
  // Raw HTML in a native dialog renders as tag soup.
  const html = '<h2>Fixed</h2><ul><li>Altimeter &amp; retry</li><li>Windows build</li></ul>';
  const text = plainReleaseNotes(html);
  assert.ok(!text.includes('<'));
  assert.match(text, /Fixed/);
  assert.match(text, /Altimeter & retry/);
});

test('release notes accept the array-of-objects shape too', () => {
  const notes = [
    { version: '0.2.0', note: '<p>Fire Perimeter Tool</p>' },
    { version: '0.1.1', note: '<p>Update prompt</p>' },
  ];
  const text = plainReleaseNotes(notes);
  assert.match(text, /Fire Perimeter Tool/);
  assert.match(text, /Update prompt/);
  assert.ok(!text.includes('<p>'));
});

test('release notes are truncated with an ellipsis', () => {
  const text = plainReleaseNotes('x'.repeat(1000), 50);
  assert.equal(text.length, 50);
  assert.ok(text.endsWith('…'));
});

test('absent or junk release notes yield an empty string, not "undefined"', () => {
  for (const junk of [undefined, null, 42, {}, []]) {
    assert.equal(plainReleaseNotes(junk), '');
  }
});

test('the unsigned-macOS error is recognised so it can degrade gracefully', () => {
  // electron-updater gives this no distinct code, so it is matched by message.
  for (const msg of [
    'Could not get code signature for running application',
    'Error: app is not signed',
    'New version 0.2.0 has invalid code signature',
  ]) {
    assert.equal(isSignatureError(msg), true, msg);
  }
  for (const msg of ['ENOTFOUND github.com', 'HTTP 404', 'ECONNRESET']) {
    assert.equal(isSignatureError(msg), false, msg);
  }
});
