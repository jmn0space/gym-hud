import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { HealthStatus } from "./HealthStatus";

describe("HealthStatus", () => {
  it("shows an unreachable server and recovers after checking again", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(Response.json({ status: "ok", database: { connected: true } }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<HealthStatus />);

    expect(screen.getByRole("status")).toHaveTextContent("Checking server…");
    expect(await screen.findByText("Server unreachable")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Check again" }));

    expect(await screen.findByText("Server online")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
