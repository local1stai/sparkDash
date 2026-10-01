/**
 * EnergyRollup — wall-energy rollups from the power meter's live watts.
 *
 * Integrates the per-Spark plug watts reported by PowerStatusProbe into
 * UTC-day and UTC-hour Wh buckets: every sample adds watts × elapsed-hours.
 * Buckets are per SPARK (every machine has a plug), so callers aggregate
 * into heads/clusters (head + its workers) at serve time — unlike tokens,
 * workers count here.
 *
 * Sampling gaps (restarts, meter outages) longer than MAX_GAP_MS are not
 * bridged: energy is slightly undercounted across gaps rather than invented.
 * Persistence mirrors TokenRollup: unbounded days, 48 h of hours, atomic
 * writes, last-sample state kept across restarts.
 */
import fs from "fs";
import { atomicWrite } from "../util/atomicWrite.js";

const FLUSH_MS = 30_000;
/** Ignore elapsed windows longer than this (restarts, stalls). */
const MAX_GAP_MS = 5 * 60_000;
/** Hours of hourly buckets to retain (2 days — the Day chart needs 24). */
const HOUR_RETENTION = 48;

function utcDayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function utcHourKey(ms) {
  return new Date(ms).toISOString().slice(0, 13);
}

function isFiniteNonNegative(n) {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

function roundWh(wh) {
  return Math.round(wh * 10) / 10;
}

export class EnergyRollup {
  /**
   * @param {object} opts
   * @param {string} opts.filePath where the buckets persist
   */
  constructor({ filePath }) {
    this._filePath = filePath;
    /** @type {Record<string, Record<string, number>>} UTC day -> sparkId -> Wh */
    this._days = {};
    /** @type {Record<string, Record<string, number>>} UTC hour -> sparkId -> Wh */
    this._hours = {};
    /** @type {number | null} ms epoch of the previous sample */
    this._lastAt = null;
    this._timer = null;
    this._flushTimer = null;
    this._dirty = false;
    this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this._filePath, "utf-8"));
      if (raw && typeof raw === "object") {
        for (const [key, store] of [
          ["days", this._days],
          ["hours", this._hours],
        ]) {
          const src = raw[key];
          if (!src || typeof src !== "object") continue;
          for (const [bucket, sparks] of Object.entries(src)) {
            if (!sparks || typeof sparks !== "object") continue;
            const clean = {};
            for (const [id, wh] of Object.entries(sparks)) {
              if (isFiniteNonNegative(wh)) clean[id] = wh;
            }
            store[bucket] = clean;
          }
        }
        if (isFiniteNonNegative(raw.lastAt)) this._lastAt = raw.lastAt;
      }
    } catch (err) {
      if (err.code !== "ENOENT") {
        console.error("[energy-rollup] failed to load, starting fresh:", err.message);
      }
    }
  }

  _flush() {
    if (!this._dirty) return;
    try {
      atomicWrite(
        this._filePath,
        JSON.stringify(
          { version: 1, days: this._days, hours: this._hours, lastAt: this._lastAt },
          null,
          2
        ) + "\n",
        0o644
      );
      this._dirty = false;
    } catch (err) {
      console.error("[energy-rollup] failed to persist:", err.message);
    }
  }

  /**
   * Fold one live sample of per-Spark watts into the buckets.
   * @param {Record<string, { watts: number | null }>} plugs sparkId -> plug state
   * @param {number} atMs sample time (ms epoch)
   */
  observe(plugs, atMs = Date.now()) {
    if (this._lastAt != null) {
      const dtMs = atMs - this._lastAt;
      if (dtMs > 0 && dtMs <= MAX_GAP_MS) {
        const dtH = dtMs / 3_600_000;
        const day = (this._days[utcDayKey(atMs)] ||= {});
        const hour = (this._hours[utcHourKey(atMs)] ||= {});
        for (const [id, plug] of Object.entries(plugs || {})) {
          const w = plug?.watts;
          if (!isFiniteNonNegative(w) || w === 0) continue;
          const wh = roundWh(w * dtH);
          day[id] = roundWh((day[id] ?? 0) + wh);
          hour[id] = roundWh((hour[id] ?? 0) + wh);
          this._dirty = true;
        }
      }
    }
    this._lastAt = atMs;
  }

  /**
   * Window totals. @param {string[] | null} ids restrict to these Sparks.
   * @returns {{ today: number, week: number, month: number, all: number }} Wh
   */
  totals(ids = null, nowMs = Date.now()) {
    const dayKeys = new Set();
    for (let i = 0; i < 30; i += 1) dayKeys.add(utcDayKey(nowMs - i * 86_400_000));
    const todayKey = utcDayKey(nowMs);
    const weekKeys = new Set();
    for (let i = 0; i < 7; i += 1) weekKeys.add(utcDayKey(nowMs - i * 86_400_000));
    const out = { today: 0, week: 0, month: 0, all: 0 };
    for (const [day, sparks] of Object.entries(this._days)) {
      for (const [id, wh] of Object.entries(sparks)) {
        if (ids != null && !ids.includes(id)) continue;
        out.all += wh;
        if (dayKeys.has(day)) out.month += wh;
        if (weekKeys.has(day)) out.week += wh;
        if (day === todayKey) out.today += wh;
      }
    }
    for (const key of ["today", "week", "month", "all"]) out[key] = roundWh(out[key]);
    return out;
  }

  /**
   * Wh per UTC day, trailing `days` days, gap-free (zero days included).
   * @param {string[] | null} ids restrict to these Sparks.
   */
  dailySeries(days = 30, nowMs = Date.now(), ids = null) {
    const series = [];
    for (let i = days - 1; i >= 0; i -= 1) {
      const day = utcDayKey(nowMs - i * 86_400_000);
      const sparks = this._days[day];
      let wh = 0;
      if (sparks) {
        for (const [id, v] of Object.entries(sparks)) {
          if (ids == null || ids.includes(id)) wh += v;
        }
      }
      series.push({ day, wh: roundWh(wh) });
    }
    return series;
  }

  /** Wh per UTC hour, trailing `hours` hours, gap-free. */
  hourlySeries(hours = 24, nowMs = Date.now(), ids = null) {
    this._pruneHours(nowMs);
    const series = [];
    const startHour = Math.floor(nowMs / 3_600_000) - (hours - 1);
    for (let i = 0; i < hours; i += 1) {
      const hour = utcHourKey((startHour + i) * 3_600_000);
      const sparks = this._hours[hour];
      let wh = 0;
      if (sparks) {
        for (const [id, v] of Object.entries(sparks)) {
          if (ids == null || ids.includes(id)) wh += v;
        }
      }
      series.push({ hour, wh: roundWh(wh) });
    }
    return series;
  }

  _pruneHours(nowMs) {
    const cutoff = utcHourKey(nowMs - HOUR_RETENTION * 3_600_000);
    for (const key of Object.keys(this._hours)) {
      if (key < cutoff) delete this._hours[key];
    }
  }

  /** @param {() => Record<string, { watts: number | null }>} getPlugs live plug watts */
  start(getPlugs, { intervalMs = 5_000, setIntervalFn = setInterval } = {}) {
    if (this._timer) return;
    this._timer = setIntervalFn(() => {
      try {
        const snap = getPlugs();
        if (snap) this.observe(snap, Date.now());
      } catch (err) {
        console.error("[energy-rollup] observe failed:", err.message);
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
