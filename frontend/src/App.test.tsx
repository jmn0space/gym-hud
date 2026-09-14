import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";

// StrictMode matches the dev entry point and double-invokes effects.
function renderApp(initialPath = "/") {
  return render(
    <StrictMode>
      <MemoryRouter initialEntries={[initialPath]}>
        <App />
      </MemoryRouter>
    </StrictMode>,
  );
}

function primaryNav() {
  return within(screen.getByRole("navigation", { name: "Primary" }));
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(Response.json({ status: "ok", database: { connected: true } }))),
  );
});

describe("navigation smoke test", () => {
  it("starts on Home with an honest empty resume state", async () => {
    renderApp();

    expect(screen.getByRole("heading", { level: 1, name: "Gym HUD" })).toBeInTheDocument();
    expect(screen.getByText("No active session.")).toBeInTheDocument();
    expect(primaryNav().getByRole("link", { name: "Home" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(await screen.findByText("Server online")).toBeInTheDocument();
  });

  it.each([
    ["PAD", "PAD walking", "Not available yet"],
    ["Resistance", "Resistance training", "Not available yet"],
    ["Cardio", "Cardio machines", "Not available yet"],
    ["History", "History", "No history yet"],
  ])("navigates to %s and shows its unavailable state", async (label, heading, stateTitle) => {
    const user = userEvent.setup();
    renderApp();

    await user.click(primaryNav().getByRole("link", { name: label }));

    const pageHeading = screen.getByRole("heading", { level: 1, name: heading });
    expect(screen.getByText(stateTitle)).toBeInTheDocument();
    expect(primaryNav().getByRole("link", { name: label })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(primaryNav().getByRole("link", { name: "Home" })).not.toHaveAttribute("aria-current");
    await waitFor(() => {
      expect(pageHeading).toHaveFocus();
    });
    expect(document.title).toBe(`${heading} · Gym HUD`);
  });

  it("leaves focus alone on first load", () => {
    renderApp("/pad");

    expect(screen.getByRole("heading", { level: 1, name: "PAD walking" })).not.toHaveFocus();
    expect(document.body).toHaveFocus();
  });

  it("returns Home from a domain screen", async () => {
    const user = userEvent.setup();
    renderApp("/history");

    await user.click(primaryNav().getByRole("link", { name: "Home" }));

    expect(screen.getByRole("heading", { level: 1, name: "Gym HUD" })).toBeInTheDocument();
  });

  it("opens a domain screen from the Home workout buttons", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole("link", { name: "PAD walking" }));

    expect(screen.getByRole("heading", { level: 1, name: "PAD walking" })).toBeInTheDocument();
  });

  it("shows a not-found screen for unknown routes", () => {
    renderApp("/nope");

    expect(screen.getByRole("heading", { level: 1, name: "Page not found" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to Home" })).toHaveAttribute("href", "/");
  });
});
