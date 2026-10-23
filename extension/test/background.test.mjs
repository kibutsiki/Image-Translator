// Unit tests for the service worker's server-call logic (retry on 429, friendly errors).
// Runs background.js in a sandbox with a fake chrome API and fake fetch:  node --test extension/test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "background.js"), "utf8");

/** Loads background.js with a scripted sequence of fetch results; returns a function to send it messages. */
function load({ settings, fetchScript }) {
  let listener;
  const waits = [];
  const calls = [];
  const queue = [...fetchScript];
  const sandbox = {
    chrome: {
      storage: { local: { get: async () => settings } },
      runtime: { onMessage: { addListener: (fn) => (listener = fn) } }
    },
    fetch: async (url, opts) => {
      calls.push({ url, opts });
      const step = queue.shift();
      if (step instanceof Error) throw step;
      return {
        ok: step.status >= 200 && step.status < 300,
        status: step.status,
        headers: { get: (h) => (h.toLowerCase() === "retry-after" ? step.retryAfter ?? null : null) },
        json: async () => step.body ?? {}
      };
    },
    // record requested waits and return immediately so tests are instant
    setTimeout: (fn, ms) => { waits.push(ms); fn(); },
    AbortSignal: { timeout: () => undefined },
    btoa, console
  };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);
  const send = (message) =>
    new Promise((resolve) => listener(message, { tab: { id: 1 } }, resolve));
  return { send, waits, calls };
}

const base = { serverUrl: "http://srv:3000/", apiToken: "tok", targetLang: "ko" };
const ask = { type: "translate-image", imageBase64: "data:image/jpeg;base64,AAAA" };
const bubbles = [{ original: "a", text: "b" }];

test("sends the bearer token, language and trims the trailing slash", async () => {
  const { send, calls } = load({ settings: base, fetchScript: [{ status: 200, body: { bubbles } }] });
  const resp = await send(ask);
  assert.deepEqual(JSON.parse(JSON.stringify(resp)), { ok: true, bubbles });
  assert.equal(calls[0].url, "http://srv:3000/vision-translate-bubbles");
  assert.equal(calls[0].opts.headers.Authorization, "Bearer tok");
  assert.equal(JSON.parse(calls[0].opts.body).target_lang, "ko");
});

test("retries on 429 and honours Retry-After, then succeeds", async () => {
  const { send, waits, calls } = load({
    settings: base,
    fetchScript: [
      { status: 429, retryAfter: "7", body: { error: "slow down" } },
      { status: 429, body: { retry_after_s: 3 } },
      { status: 200, body: { bubbles } }
    ]
  });
  const resp = await send(ask);
  assert.equal(resp.ok, true);
  assert.equal(calls.length, 3);
  assert.deepEqual([...waits], [7000, 3000]);
});

test("gives up after 3 attempts and reports the rate limit", async () => {
  const { send, calls } = load({
    settings: base,
    fetchScript: Array(5).fill({ status: 429, retryAfter: "1", body: { error: "Rate limit exceeded (30 requests per minute)." } })
  });
  const resp = await send(ask);
  assert.equal(resp.ok, false);
  assert.match(resp.error, /rate limit/i);
  assert.equal(calls.length, 3);
});

test("caps a huge Retry-After at 30 seconds", async () => {
  const { send, waits } = load({
    settings: base,
    fetchScript: [{ status: 429, retryAfter: "900" }, { status: 200, body: { bubbles } }]
  });
  await send(ask);
  assert.deepEqual([...waits], [30000]);
});

test("does not retry a 401 and explains it", async () => {
  const { send, calls } = load({ settings: base, fetchScript: [{ status: 401, body: { error: "Missing or invalid API token." } }] });
  const resp = await send(ask);
  assert.equal(resp.ok, false);
  assert.match(resp.error, /rejected your API token/);
  assert.equal(calls.length, 1);
});

test("explains an unreachable server", async () => {
  const { send } = load({ settings: base, fetchScript: [new TypeError("fetch failed")] });
  const resp = await send(ask);
  assert.equal(resp.ok, false);
  assert.match(resp.error, /Cannot reach the server at http:\/\/srv:3000/);
});

test("asks for a token instead of calling the server when none is set", async () => {
  const { send, calls } = load({ settings: { ...base, apiToken: "" }, fetchScript: [] });
  const resp = await send(ask);
  assert.equal(resp.ok, false);
  assert.match(resp.error, /No API token/);
  assert.equal(calls.length, 0);
});

test("falls back to an empty list when the server returns no bubbles field", async () => {
  const { send } = load({ settings: base, fetchScript: [{ status: 200, body: {} }] });
  assert.deepEqual(JSON.parse(JSON.stringify(await send(ask))), { ok: true, bubbles: [] });
});
