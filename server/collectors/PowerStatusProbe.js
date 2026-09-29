/**
 * PowerStatusProbe — polls an optional fleet power-meter daemon.
 *
 * One smart plug per Spark (e.g. Tapo P110s behind tapoctl) reports real
 * wall power; one fetch yields both the fleet total and per-Spark watts,
 * so this is a fleet singleton like FanStatusProbe — only instantiated
 * when POWER_METER_URL is configured (see server/index.js).
 *
 * Expected daemon payload (GET {POWER_METER_URL}/status):
 *   { plugs: [{ spark, relay_on, watts, kwh_today, kwh_month, ok, cycling }] }
 *
 * Wire shape (camelCase, plugs keyed by Spark id):
 *   { online, totalWatts, kwhToday, kwhMonth,
 *     plugs: { [sparkId]: { watts, relayOn, kwhToday, cycling, ok } },
 *     fetchedAt, error }
 */
import { POLL_INTERVAL_POWER, POWER_PROBE_TIMEOUT_MS } from "../config.js";

/**
 * @param {unknown} n
 * @returns {number | null}
 */
function numOrNull(n) {
  const v = typeof n === "string" ? Number(n) : n;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * @param {unknown} b
 * @returns {boolean | null}
 */
function boolOrNull(b) {
  return typeof b === "boolean" ? b : null;
}

/**
 * Whitelist + coerce a daemon payload into the wire shape. Pure.
 * @param {unknown} raw
 */
export function normalizePowerStatus(raw) {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const plugsRaw = Array.isArray(o.plugs) ? o.plugs : [];
  /** @type {Record<string, object>} */
  const plugs = {};
  let totalWatts = 0;
  let wattsSeen = false;
  let kwhToday = 0;
  let kwhSeen = false;
  for (const entry of plugsRaw) {
    if (!entry || typeof entry !== "object") continue;
    const id = typeof entry.spark === "string" && entry.spark.trim() ? entry.spark.trim() : null;
    if (!id || id in plugs) continue;
    const watts = numOrNull(entry.watts);
    const today = numOrNull(entry.kwh_today);
    if (watts != null) {
      totalWatts += Math.max(0, watts);
      wattsSeen = true;
    }
    if (today != null) {
      kwhToday += Math.max(0, today);
      kwhSeen = true;
    }
    plugs[id] = {
      watts,
      relayOn: boolOrNull(entry.relay_on),
      kwhToday: today,
      cycling: Boolean(entry.cycling),
      ok: entry.ok !== false,
    };
  }
  return {
    totalWatts: wattsSeen ? Math.round(totalWatts * 10) / 10 : null,
    kwhToday: kwhSeen ? Math.round(kwhToday * 1000) / 1000 : null,
    kwhMonth: numOrNull(o.kwh_month),
    plugs,
  };
}

export class PowerStatusProbe {
  /**
   * @param {string} baseUrl daemon base URL (e.g. http://127.0.0.1:5570)
   * @param {object} [opts]
   * @param {number} [opts.intervalMs] poll cadence (min 500 ms)
   * @param {number} [opts.timeoutMs] per-request timeout
   * @param {typeof setInterval} [opts.setIntervalFn] injectable for tests
   * @param {typeof clearInterval} [opts.clearIntervalFn] injectable for tests
   * @param {() => number} [opts.now] injectable for tests
   */
  constructor(
    baseUrl,
    {
      intervalMs = POLL_INTERVAL_POWER,
      timeoutMs = POWER_PROBE_TIMEOUT_MS,
      setIntervalFn = setInterval,
      clearIntervalFn = clearInterval,
      now = Date.now,
    } = {}
  ) {
    this.url = `${String(baseUrl).replace(/\/+$/, "")}/status`;
    this._intervalMs =
      Number.isFinite(intervalMs) && intervalMs >= 500 ? intervalMs : POLL_INTERVAL_POWER;
    this._timeoutMs =
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : POWER_PROBE_TIMEOUT_MS;
    this._setInterval = setIntervalFn;
    this._clearInterval = clearIntervalFn;
    this._now = now;
    this._timer = null;
    this._inFlight = false;
    /** @type {object | null} null until the first poll settles. */
    this._snapshot = null;
  }

  /** One poll. Never throws — failures produce an offline snapshot. */
  async pollOnce() {
    if (this._inFlight) return; // a slow daemon must not stack fetches
    this._inFlight = true;
    try {
      const res = await fetch(this.url, {
        signal: AbortSignal.timeout(this._timeoutMs),
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        this._snapshot = this._offline(`HTTP ${res.status}`);
        return;
      }
      const json = await res.json().catch(() => null);
      if (!json || typeof json !== "object") {
        this._snapshot = this._offline("Invalid power status JSON");
        return;
      }
      this._snapshot = {
        ...normalizePowerStatus(json),
        online: true,
        fetchedAt: this._now(),
        error: null,
      };
    } catch (err) {
      const msg =
        err?.name === "TimeoutError" || err?.name === "AbortError"
          ? `timed out after ${this._timeoutMs} ms`
          : err?.message || String(err);
      this._snapshot = this._offline(msg);
    } finally {
      this._inFlight = false;
    }
  }

  _offline(error) {
    return {
      totalWatts: null,
      kwhToday: null,
      kwhMonth: null,
      plugs: {},
      online: false,
      fetchedAt: this._now(),
      error,
    };
  }

  start() {
    if (this._timer) return;
    void this.pollOnce();
    this._timer = this._setInterval(() => void this.pollOnce(), this._intervalMs);
  }

  stop() {
    if (!this._timer) return;
    this._clearInterval(this._timer);
    this._timer = null;
  }

  /** Latest snapshot (copy); null before the first poll settles. */
  snapshot() {
    return this._snapshot ? { ...this._snapshot } : null;
  }
}
