import { test } from "node:test";
import assert from "node:assert/strict";
import { readTapoStatus, TapoProvider } from "../providers/TapoProvider.js";

/** Stub fetch serving a tapoctl /status body. */
function tapoFetch(body, { status = 200 } = {}) {
  return async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
}

const STATUS = {
  online: true,
  fetchedAt: 1731312000000,
  totalWatts: 412.5,
  plugs: {
    "gx10-95": { watts: 48.2, relayOn: true, ok: true },
    "gx10-96": { watts: null, relayOn: true, ok: false, error: "handshake failed" },
  },
};

test("TapoProvider: validate accepts a loopback url and rejects junk", () => {
  assert.deepEqual(TapoProvider.validate({ url: "http://127.0.0.1:5570" }), []);
  assert.ok(TapoProvider.validate({ url: "not a url" }).length > 0);
  assert.ok(TapoProvider.validate({}).length > 0);
});

test("TapoProvider: channel is the plug id", () => {
  assert.equal(TapoProvider.validateChannel("gx10-95"), null);
  assert.ok(TapoProvider.validateChannel("not valid!") !== null);
});

test("readTapoStatus: maps plugs and keeps the daemon's timestamp", async () => {
  const { fetchedAt, plugs } = await readTapoStatus("http://127.0.0.1:5570/", {
    fetchFn: tapoFetch(STATUS),
  });
  assert.equal(fetchedAt, 1731312000000);
  assert.equal(plugs["gx10-95"].watts, 48.2);
  assert.equal(plugs["gx10-96"].watts, null);
  assert.equal(plugs["gx10-96"].error, "handshake failed");
});

test("readPower: one request covers every channel; unknown plugs report, not reject", async () => {
  const provider = new TapoProvider(
    { url: "http://127.0.0.1:5570" },
    { fetchFn: tapoFetch(STATUS) }
  );
  const readings = await provider.readPower(["gx10-95", "gx10-96", "gx10-99"]);
  assert.equal(readings.get("gx10-95").watts, 48.2);
  assert.equal(readings.get("gx10-95").atMs, 1731312000000);
  assert.equal(readings.get("gx10-96").watts, null);
  assert.match(readings.get("gx10-96").error, /handshake/);
  assert.match(readings.get("gx10-99").error, /no such plug/);
});

test("readPower: a daemon-wide failure rejects once", async () => {
  const provider = new TapoProvider(
    { url: "http://127.0.0.1:5570" },
    { fetchFn: tapoFetch("{}", { status: 503 }) }
  );
  await assert.rejects(() => provider.readPower(["gx10-95"]), /HTTP 503/);
});

test("readPower: negative or non-numeric watts read as null, never fabricated", async () => {
  const provider = new TapoProvider(
    { url: "http://127.0.0.1:5570" },
    {
      fetchFn: tapoFetch({
        fetchedAt: 1,
        plugs: { a: { watts: -3 }, b: { watts: "lots" }, c: {} },
      }),
    }
  );
  const readings = await provider.readPower(["a", "b", "c"]);
  assert.equal(readings.get("a").watts, null);
  assert.equal(readings.get("b").watts, null);
  assert.equal(readings.get("c").watts, null);
});
