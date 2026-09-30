import { describe, expect, it, vi } from "vitest";
import { TokenCard } from "./TokenCard";
import { flush, render } from "../../testing/render";

vi.mock("../../api/client", () => ({
  fetchTokens: vi.fn(),
}));

import { fetchTokens } from "../../api/client";

const fetchTok = vi.mocked(fetchTokens);

function tokens(): import("../../api/types").TokensResponse {
  return {
    fleet: { today: 1_500_000, week: 9_000_000, month: 40_000_000, all: 100_000_000 },
    heads: [
      { id: "gx10-91", name: "GX10 91", today: 1_000_000, week: 6_000_000, month: 25_000_000, all: 60_000_000 },
      { id: "gx10-95", name: "GX10 95", today: 500_000, week: 3_000_000, month: 15_000_000, all: 40_000_000 },
    ],
  };
}

describe("TokenCard", () => {
  it("shows fleet + per-head tokens for the selected window", async () => {
    fetchTok.mockResolvedValue(tokens());
    const { container } = render(<TokenCard />);
    await flush();
    expect(container.textContent).toContain("Tokens generated");
    expect(container.textContent).toContain("1.50M");
    expect(container.textContent).toContain("GX10 91");
    expect(container.textContent).toContain("1.00M");
    expect(container.textContent).toContain("GX10 95");
    expect(container.textContent).toContain("500.0k");

    const all = [...container.querySelectorAll("button")].find((b) => b.textContent === "All");
    all?.click();
    await flush();
    expect(container.textContent).toContain("100.00M");
    expect(container.textContent).toContain("60.00M");
  });

  it("hides itself while no data has loaded", async () => {
    fetchTok.mockRejectedValue(new Error("not running"));
    const { container } = render(<TokenCard />);
    await flush();
    expect(container.textContent).toBe("");
  });
});
