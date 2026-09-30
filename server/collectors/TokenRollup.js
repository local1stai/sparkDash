/**
 * TokenRollup — daily generated-token rollups per head, from the LLM engines'
 * cumulative `totalOutputTokens` counters.
 *
 * Deltas between counter reads are exact token counts — the counter is
 * cumulative, so nothing is missed between samples. Engine restarts reset it
 * (the next read is lower); a reset rebases the baseline without counting.
 * Tokens are attributed to the UTC day of the observation. Heads only:
 * workers don't serve the LLM API, so a head's counter is its cluster's
 * total.
 *
 * Persistence: one number per head per UTC day, kept unbounded (tiny), so
 * the "all time" window stays truthful. Atomic writes; flushed on shutdown.
 */
import fs from "fs";
import { atomicWrite } from "../util/atomicWrite.js";

const FLUSH_MS = 30_000;

function utcDayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function utcHourKey(ms) {
  return new Date(ms).toISOString().slice(0, 13); // YYYY-MM-DDTHH
}

/** Hours of hourly buckets to retain (2 days — the Day chart needs 24). */
const HOUR_RETENTION = 48;

function dayKeysAgo(days, nowMs) {
  // Inclusive of today: 1 -> [today], 7 -> [today-6 .. today]
  const keys = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    keys.push(utcDayKey(nowMs - i * 86_400_000));
  }
  return keys;
}

function isNonNegativeSafeInteger(n) {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
}

export class TokenRollup {
  /**
   * @param {object} opts
   * @param {string} opts.filePath where the day buckets persist
   */
  constructor({ filePath }) {
    this._filePath = filePath;
    /** @type {Record<string, Record<string, number>>} UTC day -> headId -> tokens */
    this._days = {};
    /** @type {Record<string, Record<string, number>>} UTC hour -> headId -> tokens (short retention) */
    this._hours = {};
    /** @type {Record<string, number>} headId -> last cumulative counter */
    this._lastCounters = {};
    /** @type {Set<string>} heads with a counter observed (for zero rows) */
    this._heads = new Set();
    this._timer = null;
    this._dirty = false;
    this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this._filePath, "utf-8"));
      if (raw && typeof raw === "object" && raw.days && typeof raw.days === "object") {
        for (const [day, heads] of Object.entries(raw.days)) {
          if (!heads || typeof heads !== "object") continue;
          const clean = {};
          for (const [headId, tokens] of Object.entries(heads)) {
            if (isNonNegativeSafeInteger(tokens)) clean[headId] = tokens;
          }
          this._days[day] = clean;
        }
      }
      if (raw && typeof raw === "object" && raw.lastCounters && typeof raw.lastCounters === "object") {
        for (const [headId, counter] of Object.entries(raw.lastCounters)) {
          if (isNonNegativeSafeInteger(counter)) this._lastCounters[headId] = counter;
        }
      }
      if (raw && typeof raw === "object" && raw.hours && typeof raw.hours === "object") {
        for (const [hour, heads] of Object.entries(raw.hours)) {
          if (!heads || typeof heads !== "object") continue;
          const clean = {};
          for (const [headId, tokens] of Object.entries(heads)) {
            if (isNonNegativeSafeInteger(tokens)) clean[headId] = tokens;
          }
          this._hours[hour] = clean;
        }
      }
    } catch (err) {
      if (err.code !== "ENOENT") {
        console.error("[token-rollup] failed to load, starting fresh:", err.message);
      }
    }
  }

  _flush() {
    if (!this._dirty) return;
    try {
      atomicWrite(
        this._filePath,
        JSON.stringify(
          { version: 3, days: this._days, hours: this._hours, lastCounters: this._lastCounters },
          null,
          2
        ) + "\n",
        0o644
      );
      this._dirty = false;
    } catch (err) {
      console.error("[token-rollup] failed to persist:", err.message);
    }
  }

  /**
   * Fold one round of monitor snapshots into today's buckets. Never throws.
   * @param {object[]} snapshots monitor snapshot objects
   * @param {number} atMs observation time (ms epoch)
   */
  observe(snapshots, atMs = Date.now()) {
    const day = (this._days[utcDayKey(atMs)] ||= {});
    const hour = (this._hours[utcHourKey(atMs)] ||= {});
    for (const snap of snapshots) {
      if (!snap || snap.role !== "head") continue;
      const entries = snap?.metrics?.llm;
      if (!Array.isArray(entries)) continue;
      let total = null;
      for (const entry of entries) {
        if (entry?.available !== true) continue;
        const n = entry.totalOutputTokens;
        if (!isNonNegativeSafeInteger(n)) continue;
        total = (total ?? 0) + n; // heads can serve several ports — sum them
      }
      if (total == null) continue;
      this._heads.add(snap.id);
      const last = this._lastCounters[snap.id];
      if (last != null && total > last) {
        const delta = total - last;
        day[snap.id] = (day[snap.id] ?? 0) + delta;
        hour[snap.id] = (hour[snap.id] ?? 0) + delta; // hourly feeds the Day chart
        this._dirty = true;
      }
      // Also updated on reset/equal — rebases the baseline either way. The
      // baseline persists with the buckets so restarts do not lose deltas.
      this._lastCounters[snap.id] = total;
      this._dirty = true;
    }
  }

  /**
   * Window totals from the day buckets.
   * @param {number} nowMs
   * @returns {{ fleet: Record<string, number>, perHead: Record<string, Record<string, number>> }}
   *   fleet.window / perHead[headId].window for today | week | month | all
   */
  totals(nowMs = Date.now()) {
    const windows = { today: dayKeysAgo(1, nowMs), week: dayKeysAgo(7, nowMs), month: dayKeysAgo(30, nowMs) };
    const fleet = { today: 0, week: 0, month: 0, all: 0 };
    /** @type {Record<string, Record<string, number>>} */
    const perHead = {};
    for (const headId of this._heads) {
      perHead[headId] = { today: 0, week: 0, month: 0, all: 0 }; // observed idle heads show as zero
    }
    for (const [day, heads] of Object.entries(this._days)) {
      const inWindow = {
        today: windows.today.includes(day),
        week: windows.week.includes(day),
        month: windows.month.includes(day),
      };
      for (const [headId, tokens] of Object.entries(heads)) {
        const acc = (perHead[headId] ||= { today: 0, week: 0, month: 0, all: 0 });
        acc.all += tokens;
        fleet.all += tokens;
        for (const key of ["today", "week", "month"]) {
          if (inWindow[key]) {
            acc[key] += tokens;
            fleet[key] += tokens;
          }
        }
      }
    }
    return { fleet, perHead };
  }

  /**
   * Fleet tokens per UTC day for the trailing `days` days (today included).
   * Days without a bucket report 0, so the series is gap-free for charts.
   * @param {number} days
   * @param {number} nowMs
   * @param {string} [headId] restrict to one head (fleet sum otherwise)
   * @returns {{ day: string, tokens: number }[]}
   */
  dailySeries(days = 30, nowMs = Date.now(), headId) {
    return dayKeysAgo(days, nowMs).map((day) => {
      const heads = this._days[day];
      let tokens = 0;
      if (heads) {
        if (headId != null) tokens = heads[headId] ?? 0;
        else for (const value of Object.values(heads)) tokens += value;
      }
      return { day, tokens };
    });
  }

  /**
   * Fleet tokens per UTC hour for the trailing `hours` hours (now included).
   * Gap-free like dailySeries. Also prunes stale hour buckets (retention is
   * short — hours only feed the Day chart; days carry the long history).
   * @param {number} hours
   * @param {number} nowMs
   * @returns {{ hour: string, tokens: number }[]}
   */
  hourlySeries(hours = 24, nowMs = Date.now(), headId) {
    this._pruneHours(nowMs);
    const keys = [];
    const startHour = Math.floor(nowMs / 3_600_000) - (hours - 1);
    for (let i = 0; i < hours; i += 1) {
      keys.push(new Date((startHour + i) * 3_600_000).toISOString().slice(0, 13));
    }
    return keys.map((hour) => {
      const heads = this._hours[hour];
      let tokens = 0;
      if (heads) {
        if (headId != null) tokens = heads[headId] ?? 0;
        else for (const value of Object.values(heads)) tokens += value;
      }
      return { hour, tokens };
    });
  }

  _pruneHours(nowMs) {
    const cutoff = utcHourKey(nowMs - HOUR_RETENTION * 3_600_000);
    for (const key of Object.keys(this._hours)) {
      if (key < cutoff) delete this._hours[key];
    }
  }

  /** @param {() => object[]} getSnapshots live monitor snapshots */
  start(getSnapshots, { intervalMs = 5_000, setIntervalFn = setInterval } = {}) {
    if (this._timer) return;
    this._timer = setIntervalFn(() => {
      try {
        this.observe(getSnapshots());
      } catch (err) {
        console.error("[token-rollup] observe failed:", err.message);
      }
    }, intervalMs);
    this._flushTimer = setIntervalFn(() => this._flush(), FLUSH_MS);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    if (this._flushTimer) clearInterval(this._flushTimer);
    this._timer = null;
    this._flushTimer = null;
    this._flush();
  }
}
