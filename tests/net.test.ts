//
// net.test.ts — retry behaviour of the HTTP layer.
//
// This exists because aviationweather.gov returned a one-off HTTP 502 during
// verification while the next request succeeded. Losing the altimeter reading
// to a single blip is not acceptable for a form filled at the end of a shift.
//
// net.ts imports nothing from Electron, which is what makes it testable here.
//

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getText } from '../src/main/net.ts';

type Reply = { status: number; body?: string } | { throws: string };

/** Installs a fake fetch that plays back the given replies in order. */
function stubFetch(replies: Reply[]): { calls: () => number; restore: () => void } {
  const real = globalThis.fetch;
  let i = 0;
  globalThis.fetch = (async () => {
    const reply = replies[Math.min(i, replies.length - 1)];
    i++;
    if ('throws' in reply) throw new Error(reply.throws);
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      text: async () => reply.body ?? '',
    } as Response;
  }) as typeof fetch;
  return {
    calls: () => i,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

test('a 5xx is retried and the recovery is returned', async () => {
  const stub = stubFetch([{ status: 502 }, { status: 200, body: 'recovered' }]);
  try {
    assert.equal(await getText('https://example.test/a', 5000), 'recovered');
    assert.equal(stub.calls(), 2);
  } finally {
    stub.restore();
  }
});

test('a transport failure is retried', async () => {
  const stub = stubFetch([{ throws: 'fetch failed' }, { status: 200, body: 'ok' }]);
  try {
    assert.equal(await getText('https://example.test/b', 5000), 'ok');
    assert.equal(stub.calls(), 2);
  } finally {
    stub.restore();
  }
});

test('a 4xx is NOT retried — it is a real answer', async () => {
  const stub = stubFetch([{ status: 404 }]);
  try {
    await assert.rejects(() => getText('https://example.test/c', 5000), /HTTP 404/);
    assert.equal(stub.calls(), 1);
  } finally {
    stub.restore();
  }
});

test('persistent 5xx eventually gives up and reports the status', async () => {
  const stub = stubFetch([{ status: 503 }]);
  try {
    await assert.rejects(() => getText('https://example.test/d', 5000), /HTTP 503/);
    // Initial attempt plus one per configured delay.
    assert.equal(stub.calls(), 3);
  } finally {
    stub.restore();
  }
});
