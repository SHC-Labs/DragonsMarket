import assert from "node:assert/strict";
import test from "node:test";
import { rpc, setRpcPace } from "./chain.mjs";

const reply = (status, body = {}) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const withFetch = async (script, run) => {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(url); return script(calls.length, url); };
  try { return await run(calls); } finally { globalThis.fetch = real; }
};

test("a refused call moves to the next endpoint and the answer comes back", async () => {
  await withFetch((n) => (n === 1 ? reply(429) : reply(200, { result: { height: 7 } })), async (calls) => {
    assert.deepEqual(await rpc("https://a.example, https://b.example", "block", {}), { height: 7 });
    assert.deepEqual(calls, ["https://a.example", "https://b.example"]);
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
