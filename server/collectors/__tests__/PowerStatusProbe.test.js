import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { PowerStatusProbe, normalizePowerStatus } from "../PowerStatusProbe.js";

const HEALTHY = {
  ts: "2026-09-29 15:00:00",
  plugs: [
    { spark: "gx10-91", relay_on: true, watts: 60.7, kwh_today: 0.03, kwh_month: 0.03, ok: true, cycling: null },
    { spark: "gx10-92", relay_on: true, watts: 42.1, kwh_today: 0.02, kwh_month: 0.02, ok: true, cycling: null },
    { spark: "gx10-93", relay_on: false, watts: 0.0, kwh_today: 0.01, kwh_month: 0.01, ok: true, cycling: null },
  ],
};

test("normalizePowerStatus maps plugs by spark id and totals watts", () => {
  const out = normalizePowerStatus(HEALTHY);
  assert.equal(out.totalWatts, 102.8);
  assert.equal(out.kwhToday, 0.06);
  assert.deepEqual(Object.keys(out.plugs), ["gx10-91", "gx10-92", "gx10-93"]);
  assert.equal(out.plugs["gx10-91"].watts, 60.7);
  assert.equal(out.plugs["gx10-91"].relayOn, true);
  assert.equal(out.plugs["gx10-93"].relayOn, false);
  assert.equal(out.plugs["gx10-91"].cycling, false);
});

test("normalizePowerStatus tolerates garbage and duplicate ids", () => {
  const out = normalizePowerStatus({
    plugs: [
      { spark: "a", watts: "not-a-number", relay_on: 1 },
      { spark: "a", watts: 5 },          // duplicate id — first wins
      { spark: "", watts: 5 },           // no id — skipped
      null,
      { spark: "b", watts: -3 },         // negative clamped out of the total
    ],
  });
  assert.deepEqual(Object.keys(out.plugs), ["a", "b"]);
  assert.equal(out.plugs.a.watts, null);
  assert.equal(out.plugs.a.relayOn, null);
  assert.equal(out.plugs.b.watts, -3);
  assert.equal(out.totalWatts, 0); // only the negative sample existed
  const empty = normalizePowerStatus(null);
  assert.deepEqual(empty, { totalWatts: null, kwhToday: null, kwhMonth: null, plugs: {} });
});

/** Start a mock daemon on an ephemeral loopback port. */
async function startDaemon(handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, port: server.address().port };
}

test("pollOnce reports a healthy meter online with per-spark watts", async (t) => {
  const { server, port } = await startDaemon((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(HEALTHY));
  });
  t.after(() => server.close());

  const probe = new PowerStatusProbe(`http://127.0.0.1:${port}`);
  assert.equal(probe.snapshot(), null, "nothing before the first poll settles");
  await probe.pollOnce();
  const snap = probe.snapshot();
  assert.equal(snap.online, true);
  assert.equal(snap.totalWatts, 102.8);
  assert.equal(snap.plugs["gx10-92"].watts, 42.1);
  assert.equal(snap.error, null);
});

test("pollOnce marks an unreachable meter offline with an error", async (t) => {
  const { server, port } = await startDaemon(() => {});
  await new Promise((resolve) => server.close(resolve)); // nothing listens now
  const probe = new PowerStatusProbe(`http://127.0.0.1:${port}`);
  await probe.pollOnce();
  const snap = probe.snapshot();
  assert.equal(snap.online, false);
  assert.ok(snap.error, "expected a connection error message");
  assert.deepEqual(snap.plugs, {});
});

test("pollOnce surfaces HTTP errors and invalid JSON", async (t) => {
  const { server, port } = await startDaemon((_req, res) => {
    res.statusCode = 500;
    res.end("boom");
  });
  t.after(() => server.close());
  const probe = new PowerStatusProbe(`http://127.0.0.1:${port}`);
  await probe.pollOnce();
  assert.match(probe.snapshot().error, /HTTP 500/);
});

test("start/stop drive the poll cadence and stop cleanly", async (t) => {
  let polls = 0;
  const { server, port } = await startDaemon((_req, res) => {
    polls += 1;
    res.end(JSON.stringify(HEALTHY));
  });
  t.after(() => server.close());

  const probe = new PowerStatusProbe(`http://127.0.0.1:${port}`, { intervalMs: 500 });
  probe.start();
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.ok(polls >= 2, `expected the interval to fire, saw ${polls} polls`);
  probe.stop();
  const counted = polls;
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(polls, counted, "no further polls after stop()");
});
