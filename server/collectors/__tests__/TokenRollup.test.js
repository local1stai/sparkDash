import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TokenRollup } from "../TokenRollup.js";

const DAY = 86_400_000;

function headSnap(id, total, { role = "head", available = true } = {}) {
  return {
    id,
    role,
    metrics: { llm: [{ available, totalOutputTokens: total }] },
  };
}

test("observe counts exact counter deltas per head", () => {
  const rollup = new TokenRollup({ filePath: "/dev/null" });
  const now = Date.UTC(2026, 8, 30, 12, 0, 0);
  rollup.observe([headSnap("h1", 1000), headSnap("h2", 500)], now);
  assert.deepEqual(rollup.totals(now).fleet, { today: 0, week: 0, month: 0, all: 0 }, "first read only baselines");

  rollup.observe([headSnap("h1", 1500), headSnap("h2", 501)], now + 5000);
  const { fleet, perHead } = rollup.totals(now + 10_000);
  assert.equal(fleet.today, 501);
  assert.equal(perHead.h1.today, 500);
  assert.equal(perHead.h2.today, 1);
  assert.equal(fleet.all, 501);
});

test("observe rebases on engine reset without counting", () => {
  const rollup = new TokenRollup({ filePath: "/dev/null" });
  const now = Date.now();
  rollup.observe([headSnap("h1", 10_000)], now);
  rollup.observe([headSnap("h1", 15_000)], now + 5000); // +5000
  rollup.observe([headSnap("h1", 200)], now + 10_000); // reset — no negative
  rollup.observe([headSnap("h1", 700)], now + 15_000); // +500 after reset
  assert.equal(rollup.totals(now + 20_000).fleet.today, 5500);
});

test("totals split by day/week/month windows and sum all", () => {
  const rollup = new TokenRollup({ filePath: "/dev/null" });
  const now = Date.UTC(2026, 8, 30, 12, 0, 0); // 2026-09-30
  // Seed buckets directly: 40, 10, 3 and 1 day(s) ago, plus today via observe.
  rollup._days["2026-09-01"] = { h1: 100 }; // ~29 days ago -> month + all
  rollup._days["2026-09-24"] = { h1: 1000 }; // 6 days ago -> week + month + all
  rollup._days["2026-09-27"] = { h1: 10_000 }; // 3 days ago -> week + month + all
  rollup._days["2026-09-28"] = { h1: 100_000 }; // 2 days ago -> week + month + all
  rollup.observe([headSnap("h1", 0)], now);
  rollup.observe([headSnap("h1", 50)], now + 1000); // today: +50

  const { fleet } = rollup.totals(now + 2000);
  assert.equal(fleet.today, 50);
  assert.equal(fleet.week, 111_050);
  assert.equal(fleet.month, 111_150);
  assert.equal(fleet.all, 111_150);
});

test("workers and unavailable entries are ignored", () => {
  const rollup = new TokenRollup({ filePath: "/dev/null" });
  const now = Date.now();
  rollup.observe(
    [
      headSnap("w1", 10_000, { role: "worker" }),
      headSnap("h1", 10_000, { available: false }),
      headSnap("h1", 5000),
    ],
    now
  );
  rollup.observe([headSnap("h1", 6000)], now + 5000);
  assert.equal(rollup.totals(now + 6000).fleet.today, 1000);
});

test("dailySeries is gap-free over the trailing window", () => {
  const rollup = new TokenRollup({ filePath: "/dev/null" });
  rollup._days["2026-09-28"] = { h1: 100 };
  const now = Date.UTC(2026, 8, 30, 12, 0, 0); // 2026-09-30
  const series = rollup.dailySeries(3, now);
  assert.deepEqual(series, [
    { day: "2026-09-28", tokens: 100 },
    { day: "2026-09-29", tokens: 0 },
    { day: "2026-09-30", tokens: 0 },
  ]);
});

test("hourlySeries is gap-free and prunes stale buckets", () => {
  const rollup = new TokenRollup({ filePath: "/dev/null" });
  const now = Date.UTC(2026, 8, 30, 12, 0, 0);
  rollup._hours["2026-09-30T10"] = { h1: 400 };
  rollup._hours["2026-09-01T00"] = { h1: 9_999 }; // ancient — must be pruned
  const series = rollup.hourlySeries(3, now);
  assert.deepEqual(series, [
    { hour: "2026-09-30T10", tokens: 400 },
    { hour: "2026-09-30T11", tokens: 0 },
    { hour: "2026-09-30T12", tokens: 0 },
  ]);
  assert.equal("2026-09-01T00" in rollup._hours, false);
});

test("observe dual-writes deltas into the current day and hour buckets", () => {
  const rollup = new TokenRollup({ filePath: "/dev/null" });
  const at = Date.UTC(2026, 8, 30, 12, 3, 0);
  rollup.observe([headSnap("h1", 100)], at);
  rollup.observe([headSnap("h1", 350)], at + 5_000);
  assert.equal(rollup._days["2026-09-30"].h1, 250);
  assert.equal(rollup._hours["2026-09-30T12"].h1, 250);
});

test("series filter to a single head sums only that head", () => {
  const rollup = new TokenRollup({ filePath: "/dev/null" });
  rollup._days["2026-09-30"] = { h1: 300, h2: 500 };
  const now = Date.UTC(2026, 8, 30, 12, 0, 0);
  assert.equal(rollup.dailySeries(1, now)[0].tokens, 800);
  assert.equal(rollup.dailySeries(1, now, "h1")[0].tokens, 300);
  assert.equal(rollup.dailySeries(1, now, "missing")[0].tokens, 0);
});

test("persists day buckets and reloads them", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "token-rollup-"));
  const filePath = path.join(tmp, "token-rollup.json");
  t.after(() => import("fs").then((fs) => fs.rmSync(tmp, { recursive: true, force: true })));

  const first = new TokenRollup({ filePath });
  const now = Date.now();
  first.observe([headSnap("h1", 100)], now);
  first.observe([headSnap("h1", 350)], now + 5000);
  first._flush();

  const second = new TokenRollup({ filePath });
  const { fleet } = second.totals(now + 6000);
  assert.equal(fleet.today, 250);
  // The counter baseline persists too: tokens generated across a restart
  // (350 -> 400) are still counted exactly.
  second.observe([headSnap("h1", 400)], now + 10_000);
  assert.equal(second.totals(now + 11_000).fleet.today, 300);
});
