import { describe, expect, it } from "vitest";
import { FanStatusStrip } from "./FanStatusStrip";
import { render } from "../../testing/render";
import { makeSpark } from "../../testing/fixtures";
import type { FleetFanStatus } from "../../api/types";

function fan(overrides: Partial<FleetFanStatus> = {}): FleetFanStatus {
  return {
    online: true,
    mode: "auto",
    failsafe: false,
    fanOk: true,
    sparksOnline: 8,
    fanPctTarget: 35,
    fanPctSent: 37,
    rpm: 1320,
    pwmPercent: 37,
    ts: "2026-09-25 09:38:47",
    cycle: 11995,
    fetchedAt: Date.now(),
    error: null,
    ...overrides,
  };
}

describe("FanStatusStrip states", () => {
  it("shows RPM and the controller duty for a healthy daemon", () => {
    const { container } = render(<FanStatusStrip fan={fan()} />);
    expect(container.textContent).toContain("Fleet Fan");
    expect(container.textContent).toContain("1320");
    expect(container.textContent).toContain("37%");
    expect(container.textContent).toContain("auto");
    // target (35) differs from the controller readback (37) — surfaced as a note
    expect(container.textContent).toContain("(target 35%)");
  });

  it("hides the target note when it matches the applied duty", () => {
    const { container } = render(<FanStatusStrip fan={fan({ fanPctTarget: 37 })} />);
    expect(container.textContent).not.toContain("target");
  });

  it("flags failsafe, controller faults, hold, and unreachable daemons", () => {
    const failsafe = render(
      <FanStatusStrip fan={fan({ failsafe: true, mode: "FAILSAFE", fanPctSent: 70 })} />
    );
    expect(failsafe.container.textContent).toContain("Failsafe engaged");

    const fault = render(<FanStatusStrip fan={fan({ fanOk: false })} />);
    expect(fault.container.textContent).toContain("Fan controller fault");

    const hold = render(<FanStatusStrip fan={fan({ mode: "hold" })} />);
    expect(hold.container.textContent).toContain("Hold");

    const offline = render(
      <FanStatusStrip fan={fan({ online: false, mode: null, rpm: null, error: "ECONNREFUSED" })} />
    );
    expect(offline.container.textContent).toContain("Fan daemon unreachable: ECONNREFUSED");
  });

  it("renders em-dashes for missing numeric fields", () => {
    const sparse = render(
      <FanStatusStrip
        fan={fan({ rpm: null, pwmPercent: null, fanPctTarget: null, fanPctSent: null, sparksOnline: null })}
      />
    );
    expect(sparse.container.textContent).toContain("—");
  });

  it("shows the fleet power pane alongside the fan", () => {
    const power = {
      online: true,
      totalWatts: 341.1,
      kwhToday: 0.42,
      kwhMonth: null,
      plugs: {
        "gx10-91": { watts: 60.7, relayOn: true, kwhToday: 0.03, kwhMonth: 0.03, cycling: false, ok: true, error: null },
        "gx10-92": { watts: 42.1, relayOn: true, kwhToday: 0.02, kwhMonth: 0.02, cycling: false, ok: true, error: null },
      },
      fetchedAt: Date.now(),
      error: null,
    };
    const { container } = render(<FanStatusStrip fan={fan()} power={power} />);
    expect(container.textContent).toContain("Fleet power");
    expect(container.textContent).toContain("341 W");
    expect(container.textContent).toContain("0.42 kWh");
    expect(container.textContent).toContain("2/2");
  });

  it("lists broken plugs with their daemon error", () => {
    const power = {
      online: true,
      totalWatts: 100,
      kwhToday: 0.1,
      kwhMonth: 0.1,
      plugs: {
        "gx10-91": { watts: 100, relayOn: true, kwhToday: 0.1, kwhMonth: 0.1, cycling: false, ok: true, error: null },
        "gx10-92": { watts: null, relayOn: null, kwhToday: null, kwhMonth: null, cycling: false, ok: false, error: "backoff after 3 failures: 403" },
      },
      fetchedAt: Date.now(),
      error: null,
    };
    const { container } = render(<FanStatusStrip fan={fan()} power={power} />);
    expect(container.textContent).toContain("gx10-92: backoff after 3 failures: 403");
  });

  it("renders power-only when no fan daemon is configured", () => {
    const power = {
      online: false,
      totalWatts: null,
      kwhToday: null,
      kwhMonth: null,
      plugs: {},
      fetchedAt: Date.now(),
      error: "ECONNREFUSED",
    };
    const { container } = render(<FanStatusStrip power={power} />);
    expect(container.textContent).toContain("Fleet Power");
    expect(container.textContent).toContain("Power meter unreachable: ECONNREFUSED");
    expect(container.textContent).not.toContain("RPM");
  });

  it("groups plug watts per head/worker cluster", () => {
    const head = (id: string, name: string) => ({ ...makeSpark(id), name, role: "head" as const });
    const worker = (id: string, name: string, headId: string) => ({
      ...makeSpark(id),
      name,
      role: "worker" as const,
      workerHeadId: headId,
    });
    const sparks = [
      head("gx10-91", "GX10 91"),
      worker("gx10-92", "GX10 92", "gx10-91"),
      worker("gx10-93", "GX10 93", "gx10-91"),
      head("gx10-95", "GX10 95"),
      worker("gx10-96", "GX10 96", "gx10-95"),
    ];
    const plug = (watts: number, kwhToday: number) => ({
      watts,
      relayOn: true,
      kwhToday,
      kwhMonth: kwhToday * 2,
      cycling: false,
      ok: true,
      error: null,
    });
    const power = {
      online: true,
      totalWatts: 200,
      kwhToday: 0.4,
      kwhMonth: 0.4,
      plugs: {
        "gx10-91": plug(60, 0.1),
        "gx10-92": plug(40, 0.05),
        "gx10-93": plug(50, 0.05),
        "gx10-95": plug(30, 0.1),
        "gx10-96": plug(20, 0.1),
      },
      fetchedAt: Date.now(),
      error: null,
    };
    const { container } = render(<FanStatusStrip power={power} sparks={sparks} />);
    expect(container.textContent).toContain("GX10 91");
    expect(container.textContent).toContain("150 W");
    expect(container.textContent).toContain("0.20 today");
    expect(container.textContent).toContain("0.40 month");
    expect(container.textContent).toContain("GX10 95");
    expect(container.textContent).toContain("50 W");
  });
});
