import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "path";
import test from "node:test";
import { EnergyRollup } from "../EnergyRollup.js";

const S = 1000;

test("observe integrates watts into day and hour buckets", () => {
  const rollup = new EnergyRollup({ filePath: "/dev/null" });
  const at = Date.UTC(2026, 9, 1, 12, 0, 0);
  rollup.observe({ "gx10-91": { watts: 400 }, "gx10-95": { watts: 100 } }, at); // baseline
  rollup.observe({ "gx10-91": { watts: 400 }, "gx10-95": { watts: 100 } }, at + 60 * S);
  // 400 W for 60 s = 6.67 Wh; 100 W for 60 s = 1.67 Wh
  assert.equal(rollup._days["2026-10-01"]["gx10-91"], 6.7);
  assert.equal(rollup._days["2026-10-01"]["gx10-95"], 1.7);
  assert.equal(rollup._hours["2026-10-01T12"]["gx10-91"], 6.7);
});

test("observe ignores gaps, null watts and time going backwards", () => {
  const rollup = new EnergyRollup({ filePath: "/dev/null" });
  const at = Date.UTC(2026, 9, 1, 12, 0, 0);
  rollup.observe({ a: { watts: 600 } }, at); // baseline
  rollup.observe({ a: { watts: 600 } }, at + 10 * 60 * S); // 10 min gap — re-anchor only
  assert.equal(rollup._days["2026-10-01"], undefined);
  // 30 s after the re-anchor: counts exactly that window.
  rollup.observe({ a: { watts: 600 }, b: { watts: null } }, at + 10 * 60 * S + 30 * S);
  assert.equal(rollup._days["2026-10-01"].a, 5); // 600 W × 30 s = 5 Wh
  assert.equal(rollup._days["2026-10-01"].b, undefined);
  // Time going backwards is ignored and re-anchors without counting.
  rollup.observe({ a: { watts: 600 } }, at + 20 * S);
  assert.equal(rollup.totals(null, at + 60 * S).all, 5);
});

test("totals and series filter to a set of spark ids", () => {
  const rollup = new EnergyRollup({ filePath: "/dev/null" });
  rollup._days["2026-10-01"] = { "gx10-91": 100, "gx10-92": 50, "gx10-95": 30 };
  const now = Date.UTC(2026, 9, 1, 12, 0, 0);
  assert.equal(rollup.totals(null, now).all, 180);
  assert.equal(rollup.totals(["gx10-91", "gx10-92"], now).all, 150);
  assert.equal(rollup.dailySeries(1, now, ["gx10-95"])[0].wh, 30);
  assert.equal(rollup.dailySeries(1, now)[0].wh, 180);
});

test("series are gap-free over the trailing window", () => {
  const rollup = new EnergyRollup({ filePath: "/dev/null" });
  rollup._days["2026-09-30"] = { a: 42 };
  const now = Date.UTC(2026, 9, 2, 12, 0, 0); // Oct 2 -> trailing 3 days: Sep 30, Oct 1, Oct 2
  const series = rollup.dailySeries(3, now);
  assert.deepEqual(
    series.map((d) => d.day),
    ["2026-09-30", "2026-10-01", "2026-10-02"]
  );
  assert.equal(series[0].wh, 42);
  assert.equal(series[1].wh, 0);
  assert.equal(series[2].wh, 0);
});

test("persists buckets and the sample anchor", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "energy-rollup-"));
  const filePath = path.join(tmp, "power-rollup.json");
  t.after(() => import("fs").then((fs) => fs.rmSync(tmp, { recursive: true, force: true })));

  const first = new EnergyRollup({ filePath });
  const at = Date.UTC(2026, 9, 1, 12, 0, 0);
  first.observe({ a: { watts: 1000 } }, at);
  first.observe({ a: { watts: 1000 } }, at + 36 * S); // 10 Wh
  first._flush();

  const second = new EnergyRollup({ filePath });
  assert.equal(second.totals(null, at + 60 * S).all, 10);
  // Anchor persists: the next sample after a reload still integrates.
  second.observe({ a: { watts: 1000 } }, at + 72 * S); // +10 Wh
  assert.equal(second.totals(null, at + 80 * S).all, 20);
});
