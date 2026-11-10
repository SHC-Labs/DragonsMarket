import assert from "node:assert/strict";
import test from "node:test";
import { rpc, setRpcPace, setRpcCredentials } from "./chain.mjs";

const reply = (status, body = {}) => Response.json(body, { status });
const withFetch = async (script, run) => {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push(url); return script(calls.length, url, init); };
  try { return await run(calls); } finally { globalThis.fetch = real; }
};

test("a refused call moves to the next endpoint and the answer comes back", async () => {
  await withFetch((n) => (n === 1 ? reply(429) : reply(200, { result: { height: 7 } })), async (calls) => {
    assert.deepEqual(await rpc("https://a.example, https://b.example", "block", {}), { height: 7 });
    assert.deepEqual(calls, ["https://a.example", "https://b.example"]);
  });
});

test('RPC credentials are bound to an exact HTTPS endpoint and redirects are refused', async () => {
  setRpcCredentials([['https://a.example/private', 'private-test-token']]);
  try {
    await withFetch((n, url, init) => {
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers.Authorization, url === 'https://a.example/private' ? 'Bearer private-test-token' : undefined);
      return n === 1 ? reply(503) : reply(200, { result: true });
    }, async () => {
      assert.equal(await rpc('https://a.example/private,https://b.example', 'block', {}), true);
      assert.equal(await rpc('https://a.example/elsewhere', 'block', {}), true);
    });
    for (const endpoint of ['http://a.example', 'https://user:pass@a.example', 'https://a.example?token=secret', 'https://a.example/#fragment']) {
      assert.throws(() => setRpcCredentials([[endpoint, 'private-test-token']]));
    }
    assert.throws(() => setRpcCredentials([['https://a.example', 'newline\nsecret']]));
  } finally { setRpcCredentials([]); }
});

test('RPC responses are bounded and incomplete or malformed bodies are refused', async () => {
  for (const response of [new Response('not-json'), new Response(new Uint8Array([0xff])),
    new Response(new Uint8Array(16 * 1024 * 1024 + 1)), Response.json(null), Response.json({}),
    new Response(new ReadableStream({ start(controller) { controller.error(new Error('connection lost')); } }))]) {
    await withFetch(() => response, async () => { await assert.rejects(rpc('https://a.example', 'block', {})); });
  }
  for (const pace of [-1, NaN, 0.5, 60001]) assert.throws(() => setRpcPace(pace));
});

test('RPC failures cannot echo a provider credential into keeper logs', async () => {
  await withFetch(() => reply(200, { error: { name: 'private-token', data: 'private-token' } }), async () => {
    await assert.rejects(rpc('https://a.example', 'block', {}), error => error.message === 'block: RPC_ERROR');
  });
  await withFetch(() => new Response('private-token is not JSON'), async () => {
    await assert.rejects(rpc('https://a.example', 'block', {}), error => error.message === 'RPC response unavailable or invalid');
  });
});

test("a dropped connection and a server error are retried too", async () => {
  await withFetch((n) => { if (n === 1) throw new TypeError("fetch failed"); return n === 2 ? reply(503) : reply(200, { result: "ok" }); }, async (calls) => {
    assert.equal(await rpc("https://a.example,https://b.example", "status", {}), "ok");
    assert.equal(calls.length, 3);
  });
});

test("when every endpoint refuses the error says so", async () => {
  await withFetch(() => reply(429), async () => {
    await assert.rejects(rpc("https://a.example", "block", {}), /every RPC endpoint refused: block: HTTP 429/);
  });
});

test("an answer that is an error is not retried", async () => {
  await withFetch(() => reply(200, { error: { name: "UNKNOWN_BLOCK" } }), async (calls) => {
    await assert.rejects(rpc("https://a.example,https://b.example", "block", {}), /UNKNOWN_BLOCK/);
    assert.equal(calls.length, 1);
  });
  await withFetch(() => reply(404), async (calls) => {
    await assert.rejects(rpc("https://a.example", "block", {}), /HTTP 404/);
    assert.equal(calls.length, 1);
  });
});

test("calls are spaced at least the pace apart", async () => {
  setRpcPace(60);
  try {
    await withFetch(() => reply(200, { result: 1 }), async () => {
      const started = Date.now();
      await rpc("https://a.example", "block", {});
      await rpc("https://a.example", "block", {});
      await rpc("https://a.example", "block", {});
      assert.ok(Date.now() - started >= 110, `three calls took ${Date.now() - started} ms`);
    });
  } finally {
    setRpcPace(0);
  }
});
