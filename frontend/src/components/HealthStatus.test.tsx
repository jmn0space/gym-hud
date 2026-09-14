import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { HEALTH_TIMEOUT_MS, HealthStatus } from "./HealthStatus";

describe("HealthStatus", () => {
  it("shows an unreachable server and recovers after checking again", async () => {
    let resolveRecheck: (response: Response) => void = () => undefined;
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveRecheck = resolve;
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<HealthStatus />);

    expect(screen.getByRole("status")).toHaveTextContent("Checking server…");
    expect(await screen.findByText("Server unreachable")).toBeInTheDocument();

    const button = screen.getByRole("button", { name: "Check again" });
    await user.click(button);

    // While checking, the button keeps focus and ignores repeat presses.
    expect(screen.getByRole("status")).toHaveTextContent("Checking server…");
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveFocus();
    await user.click(button);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    act(() => {
      resolveRecheck(Response.json({ status: "ok", database: { connected: true } }));
    });

    expect(await screen.findByText("Server online")).toBeInTheDocument();
    expect(button).toHaveAttribute("aria-disabled", "false");
  });

  it("reports a reachable server with an unavailable database", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          Response.json({ status: "degraded", database: { connected: false } }, { status: 503 }),
        ),
      ),
    );

    render(<HealthStatus />);

    expect(await screen.findByText("Server reachable, database unavailable")).toBeInTheDocument();
  });

  it("gives up and reports unreachable after the timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          }),
      ),
    );

    render(<HealthStatus />);

    await act(() => vi.advanceTimersByTimeAsync(HEALTH_TIMEOUT_MS - 1));
    expect(screen.getByRole("status")).toHaveTextContent("Checking server…");

    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByRole("status")).toHaveTextContent("Server unreachable");
  });
});
