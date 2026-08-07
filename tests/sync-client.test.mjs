import test from 'node:test';
import assert from 'node:assert/strict';

import { syncPull, syncPush } from '../sync/client.mjs';

const USER_ID = '7309f8e0-d5a4-4a6b-8e15-295b3f9a1c42';

test('syncPull 使用 no-store,外部 AbortSignal 可取消请求', async () => {
  const originalFetch = globalThis.fetch;
  let seenInit;
  globalThis.fetch = async (_url, init) => {
    seenInit = init;
    return new Promise((resolve, reject) => {
      if (init.signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  };

  try {
    const controller = new AbortController();
    const pending = syncPull('https://sync.example.test', USER_ID, { signal: controller.signal });
    await Promise.resolve();
    assert.equal(seenInit.cache, 'no-store');
    assert.equal(seenInit.signal.aborted, false);
    controller.abort();
    assert.deepEqual(await pending, { ok: false, error: 'network' });
    assert.equal(seenInit.signal.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('syncPull 正确区分远端为空', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error: 'none' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
  try {
    assert.deepEqual(
      await syncPull('https://sync.example.test', USER_ID),
      { ok: false, error: 'none', blob: null },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('syncPush 保留 429/413 错误语义', async () => {
  const originalFetch = globalThis.fetch;
  const statuses = [429, 413];
  globalThis.fetch = async () => new Response('{}', { status: statuses.shift() });
  try {
    assert.deepEqual(
      await syncPush('https://sync.example.test', USER_ID, { ciphertext: true }),
      { ok: false, error: 'rate' },
    );
    assert.deepEqual(
      await syncPush('https://sync.example.test', USER_ID, { ciphertext: true }),
      { ok: false, error: 'too-big' },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
