import { describe, expect, it } from "vitest";
import { FanStatusStrip } from "./FanStatusStrip";
import { render } from "../../testing/render";
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
});
