/**
 * Tapo smart plugs through a tapoctl-style daemon (loopback HTTP).
 *
 * One daemon meters the whole rack: `GET {url}/status` returns every plug at once
 * (`{ online, fetchedAt, totalWatts, plugs: { <sparkId>: { watts, ok, error, … } } }`),
 * and a unit's channel is simply its plug id — by convention the spark id itself.
 * Live-only: the P110 keeps no 5-minute series the daemon can serve, so the
 * tracker's own minute buckets (and the ratio fill) do the accounting.
 *
 * Config entry: { "type": "tapo", "url": "http://127.0.0.1:5570" }
 * The daemon is expected on loopback next to sparkDash (it holds the plug
 * credentials); nothing but its URL is configured here.
 */
import { PowerMeterProvider } from "./PowerMeterProvider.js";

const DEFAULT_TIMEOUT_MS = 8_000;
/** One /status body for eight plugs is well under 2 KiB. */
const MAX_STATUS_BYTES = 64 * 1024;

/**
 * Read the daemon's /status into per-plug readings. Exported for tests.
 * The daemon serves `plugs` as a list; every item carries its `spark` id,
 * its own `ts` and the live `watts` (see /home/admin/tapoctl).
 * @param {string} url
 * @param {{ fetchFn?: typeof fetch, timeoutMs?: number }} [opts]
 * @returns {Promise<{ fetchedAt: number | null, plugs: Record<string, { watts: number | null, atMs: number | null, error?: string }> }>}
 */
export async function readTapoStatus(url, { fetchFn = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const res = await fetchFn(`${url.replace(/\/+$/, "")}/status`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`tapoctl replied HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_STATUS_BYTES) throw new Error("tapoctl status body over the size cap");
  const json = JSON.parse(text);
  if (!json || typeof json !== "object" || !Array.isArray(json.plugs)) {
    throw new Error("tapoctl status is missing the plugs list");
  }
  const fetchedAt = Number(json.ts) || null;
  const plugs = {};
  for (const plug of json.plugs) {
    if (!plug || typeof plug.spark !== "string" || !plug.spark) continue;
    const watts = plug.watts;
    const atMs = Number(plug.ts) || fetchedAt;
    plugs[plug.spark] = {
      watts: Number.isFinite(watts) && watts >= 0 ? watts : null,
      atMs,
      ...(plug.error ? { error: String(plug.error) } : {}),
    };
  }
  return { fetchedAt, plugs };
}

export class TapoProvider extends PowerMeterProvider {
  static type = "tapo";
  static label = "Tapo smart plugs (tapoctl daemon)";

  /** @param {Record<string, unknown>} spec */
  static validate(spec) {
    const problems = [];
    try {
      const u = new URL(String(spec.url));
      if (u.protocol !== "http:" && u.protocol !== "https:") problems.push('url must be http(s)://…');
    } catch {
      problems.push("url must be a valid http(s) URL of the tapoctl daemon");
    }
    return problems;
  }

  /**
   * A channel is the daemon's plug id (the spark id by convention).
   * @param {string} channel
   */
  static validateChannel(channel) {
    return /^[\w.-]{1,64}$/.test(channel) ? null : "channel must be the plug's id (the unit id)";
  }

  /**
   * @param {Record<string, unknown>} spec
   * @param {{ fetchFn?: typeof fetch }} [_deps]
   */
  constructor(spec, _deps = {}) {
    super(spec, _deps);
    this.url = String(spec.url);
    this.fetchFn = _deps.fetchFn ?? fetch;
  }

  describe() {
    return { type: this.type, target: this.url };
  }

  /**
   * One /status read covers every channel; per-plug failures become watts:null
   * readings, only a daemon-wide failure rejects.
   * @param {string[]} channels
   * @param {import("./PowerMeterProvider.js").ReadOptions} [_options]
   */
  async readPower(channels, _options = {}) {
    const { plugs } = await readTapoStatus(this.url, { fetchFn: this.fetchFn });
    const out = new Map();
    for (const channel of channels) {
      const plug = plugs[channel];
      if (!plug) {
        out.set(channel, { watts: null, atMs: Date.now(), error: "no such plug in tapoctl config" });
      } else {
        out.set(channel, { watts: plug.watts, atMs: plug.atMs ?? Date.now(), ...(plug.error ? { error: plug.error } : {}) });
      }
    }
    return out;
  }
}
