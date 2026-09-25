import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import http from "node:http";
import { createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { WebSocket } from "ws";

const FAN_PAYLOAD = {
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
};

async function freePort() {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function nextMessage(ws, timeoutMs = 1_000) {
  return Promise.race([
    once(ws, "message").then(([data]) => String(data)),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("timed out waiting for WebSocket message")), timeoutMs)
    ),
  ]);
}

/** Read snapshots until one matches; the fan field appears after the first
 * daemon poll, which can land after the client's initial snapshot. */
async function waitForSnapshot(ws, predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    assert.ok(remaining > 0, "timed out waiting for a matching snapshot");
    const msg = JSON.parse(await nextMessage(ws, remaining));
    if (msg.type === "snapshot" && predicate(msg)) return msg;
  }
}

async function spawnServer(t, { port, sparksPath, extraEnv = {} }) {
  const tmp = path.dirname(sparksPath);
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: path.resolve(import.meta.dirname, "../../.."),
    env: {
      ...process.env,
      // dotenv does not override vars already present; pinning these keeps a
      // developer's local .env from leaking auth/binds into the test server.
      SPARKDASH_TOKEN: "",
      BIND_HOST: "127.0.0.1",
      PORT: String(port),
      SPARKS_JSON_PATH: sparksPath,
      SPARKS_SECRETS_PATH: path.join(tmp, "sparks-secrets.json"),
      SECRETS_KEY_PATH: path.join(tmp, ".secrets-key"),
      LLM_DAILY_JSON_PATH: path.join(tmp, "llm-daily.json"),
      FLEET_ENERGY_JSON_PATH: path.join(tmp, "fleet-energy.json"),
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));

  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  await Promise.race([
    new Promise((resolve) => {
      const check = () =>
        output.includes("server listening") ? resolve() : setTimeout(check, 10);
      check();
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 4_000)
    ),
  ]);
  return child;
}

test("fan status reaches the WebSocket snapshot and /api/fan when FAN_STATUS_URL is set", async (t) => {
  const daemon = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(FAN_PAYLOAD));
  });
  daemon.listen(0, "127.0.0.1");
  await once(daemon, "listening");
  t.after(() => daemon.close());
  const daemonPort = daemon.address().port;

  const tmp = await mkdtemp(path.join(os.tmpdir(), "sparkdash-fan-"));
  const sparksPath = path.join(tmp, "sparks.json");
  await writeFile(sparksPath, "[]\n");
  const port = await freePort();
  await spawnServer(t, {
    port,
    sparksPath,
    extraEnv: {
      FAN_STATUS_URL: `http://127.0.0.1:${daemonPort}/status`,
      POLL_INTERVAL_FAN: "500",
    },
  });

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  t.after(() => ws.close());
  await once(ws, "open");
  const withFan = await waitForSnapshot(ws, (msg) => msg.fan != null);
  assert.equal(withFan.fan.online, true);
  assert.equal(withFan.fan.rpm, 1320);
  assert.equal(withFan.fan.mode, "auto");
  assert.equal(withFan.fan.sparksOnline, 8);
  assert.equal(withFan.fan.error, null);

  const res = await fetch(`http://127.0.0.1:${port}/api/fan`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.online, true);
  assert.equal(body.rpm, 1320);
});

test("fan stays fully absent when FAN_STATUS_URL is unset", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sparkdash-nofan-"));
  const sparksPath = path.join(tmp, "sparks.json");
  await writeFile(sparksPath, "[]\n");
  const port = await freePort();
  await spawnServer(t, { port, sparksPath, extraEnv: { FAN_STATUS_URL: "" } });

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  t.after(() => ws.close());
  await once(ws, "open");
  const first = JSON.parse(await nextMessage(ws));
  assert.equal(first.type, "snapshot");
  assert.equal("fan" in first, false, "unconfigured deployments must not see a fan key");

  const res = await fetch(`http://127.0.0.1:${port}/api/fan`);
  assert.equal(res.status, 404);
});
