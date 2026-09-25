/**
 * FanStatusProbe — polls an optional fleet fan daemon status endpoint.
 *
 * Racks that share one fan across every Spark (a single controller channel)
 * have no per-Spark fan metrics; a small daemon tracks the shared fan and
 * exposes its decision as JSON (mode, duty, RPM). This probe surfaces that
 * status fleet-wide. It is a singleton, not a per-Spark collector, and it is
 * only instantiated when FAN_STATUS_URL is configured (see server/index.js).
 *
 * Wire shape (camelCase; daemon fields are snake_case):
 *   { online, mode, failsafe, fanOk, sparksOnline, fanPctTarget, fanPctSent,
 *     rpm, pwmPercent, ts, cycle, fetchedAt, error }
 */
import { FAN_PROBE_TIMEOUT_MS, POLL_INTERVAL_FAN } from "../config.js";

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
 * Whitelist + coerce a raw daemon payload into the metric fields of the wire
 * shape. Pure — safe to unit-test without a server.
 * @param {unknown} raw
 */
export function normalizeFanStatus(raw) {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const mode =
    o.mode === "auto" || o.mode === "hold" || o.mode === "FAILSAFE" ? o.mode : null;
  return {
    mode,
    failsafe: Boolean(o.failsafe),
    fanOk: boolOrNull(o.fan_ok),
    sparksOnline: numOrNull(o.sparks_online),
    fanPctTarget: numOrNull(o.fan_pct_target),
    fanPctSent: numOrNull(o.fan_pct_sent),
    rpm: numOrNull(o.rpm),
    pwmPercent: numOrNull(o.pwm_percent),
    ts: typeof o.ts === "string" ? o.ts : null,
    cycle: numOrNull(o.cycle),
  };
}

export class FanStatusProbe {
  /**
   * @param {string} url status endpoint (e.g. http://127.0.0.1:5560/status)
   * @param {object} [opts]
   * @param {number} [opts.intervalMs] poll cadence (min 500 ms)
   * @param {number} [opts.timeoutMs] per-request timeout
   * @param {typeof setInterval} [opts.setIntervalFn] injectable for tests
   * @param {typeof clearInterval} [opts.clearIntervalFn] injectable for tests
   * @param {() => number} [opts.now] injectable for tests
   */
  constructor(
    url,
    {
      intervalMs = POLL_INTERVAL_FAN,
      timeoutMs = FAN_PROBE_TIMEOUT_MS,
      setIntervalFn = setInterval,
      clearIntervalFn = clearInterval,
      now = Date.now,
    } = {}
  ) {
    this.url = String(url);
    this._intervalMs =
      Number.isFinite(intervalMs) && intervalMs >= 500 ? intervalMs : POLL_INTERVAL_FAN;
    this._timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : FAN_PROBE_TIMEOUT_MS;
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
        this._snapshot = this._offline("Invalid fan status JSON");
        return;
      }
      this._snapshot = {
        ...normalizeFanStatus(json),
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
      mode: null,
      failsafe: false,
      fanOk: null,
      sparksOnline: null,
      fanPctTarget: null,
      fanPctSent: null,
      rpm: null,
      pwmPercent: null,
      ts: null,
      cycle: null,
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
