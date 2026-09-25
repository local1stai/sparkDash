import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { FanStatusProbe, normalizeFanStatus } from "../FanStatusProbe.js";

const HEALTHY = {
  ts: "2026-09-25 09:38:47",
  cycle: 11995,
  fan_pct_target: 35,
  fan_pct_sent: 37,
  fan_ok: true,
  failsafe: false,
  mode: "auto",
  sparks_online: 8,
  rpm: 1320,
  pwm_percent: 37,
  unknown_extra: "dropped",
};

test("normalizeFanStatus whitelists and coerces a daemon payload", () => {
  const out = normalizeFanStatus(HEALTHY);
  assert.equal(out.mode, "auto");
  assert.equal(out.failsafe, false);
  assert.equal(out.fanOk, true);
  assert.equal(out.sparksOnline, 8);
  assert.equal(out.fanPctTarget, 35);
  assert.equal(out.fanPctSent, 37);
  assert.equal(out.rpm, 1320);
  assert.equal(out.pwmPercent, 37);
  assert.equal(out.ts, "2026-09-25 09:38:47");
  assert.equal(out.cycle, 11995);
  assert.equal("unknown_extra" in out, false);
});

test("normalizeFanStatus maps FAILSAFE and tolerates garbage", () => {
  const out = normalizeFanStatus({ mode: "FAILSAFE", failsafe: true });
  assert.equal(out.mode, "FAILSAFE");
  assert.equal(out.failsafe, true);

  const garbage = normalizeFanStatus({ mode: "weird", rpm: "not-a-number", fan_ok: 1 });
  assert.equal(garbage.mode, null);
  assert.equal(garbage.rpm, null);
  assert.equal(garbage.fanOk, null);
  assert.deepEqual(normalizeFanStatus(null), normalizeFanStatus({}));
  assert.deepEqual(normalizeFanStatus([1, 2]), normalizeFanStatus({}));
});

/** Start a mock daemon on an ephemeral loopback port. */
async function startDaemon(handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, port: server.address().port };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("pollOnce reports a healthy daemon online", async (t) => {
  const { server, port } = await startDaemon((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(HEALTHY));
  });
  t.after(() => server.close());

  const probe = new FanStatusProbe(`http://127.0.0.1:${port}/status`);
  assert.equal(probe.snapshot(), null, "nothing before the first poll settles");
  await probe.pollOnce();
  const snap = probe.snapshot();
  assert.equal(snap.online, true);
  assert.equal(snap.rpm, 1320);
  assert.equal(snap.mode, "auto");
  assert.equal(snap.sparksOnline, 8);
  assert.equal(snap.error, null);
});

test("pollOnce marks an unreachable daemon offline with an error", async (t) => {
  const { server, port } = await startDaemon(() => {});
  await new Promise((resolve) => server.close(resolve)); // nothing listens now
  const probe = new FanStatusProbe(`http://127.0.0.1:${port}/status`);
  await probe.pollOnce();
  const snap = probe.snapshot();
  assert.equal(snap.online, false);
  assert.ok(snap.error, "expected a connection error message");
  assert.equal(snap.rpm, null);
});

test("pollOnce surfaces HTTP error statuses", async (t) => {
  const { server, port } = await startDaemon((_req, res) => {
    res.statusCode = 500;
    res.end("boom");
  });
  t.after(() => server.close());
  const probe = new FanStatusProbe(`http://127.0.0.1:${port}/status`);
  await probe.pollOnce();
  const snap = probe.snapshot();
  assert.equal(snap.online, false);
  assert.match(snap.error, /HTTP 500/);
});

test("pollOnce rejects invalid JSON bodies", async (t) => {
  const { server, port } = await startDaemon((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end("<html>not json</html>");
  });
  t.after(() => server.close());
  const probe = new FanStatusProbe(`http://127.0.0.1:${port}/status`);
  await probe.pollOnce();
  const snap = probe.snapshot();
  assert.equal(snap.online, false);
  assert.match(snap.error, /Invalid fan status JSON/);
});

test("pollOnce times out a hanging daemon", async (t) => {
  const { server, port } = await startDaemon(() => {
    /* never responds */
  });
  t.after(() => server.close());
  const probe = new FanStatusProbe(`http://127.0.0.1:${port}/status`, { timeoutMs: 80 });
  await probe.pollOnce();
  const snap = probe.snapshot();
  assert.equal(snap.online, false);
  assert.match(snap.error, /timed out/);
});

test("start/stop drive the poll cadence and stop cleanly", async (t) => {
  let polls = 0;
  const { server, port } = await startDaemon((_req, res) => {
    polls += 1;
    res.end(JSON.stringify(HEALTHY));
  });
  t.after(() => server.close());

  const probe = new FanStatusProbe(`http://127.0.0.1:${port}/status`, { intervalMs: 500 });
  probe.start();
  await sleep(700); // immediate first poll + one interval tick
  assert.ok(polls >= 2, `expected the interval to fire, saw ${polls} polls`);
  probe.stop();
  const counted = polls;
  await sleep(700);
  assert.equal(polls, counted, "no further polls after stop()");
});
