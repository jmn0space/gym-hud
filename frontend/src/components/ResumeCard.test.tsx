import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { ResumeCard } from "./ResumeCard";
import { formatDuration } from "./TimerDisplay";

describe("ResumeCard", () => {
  it("exposes a named Resume action with the session state and elapsed time", () => {
    render(
      <MemoryRouter>
        <ResumeCard
          session={{
            id: "pad-1",
            title: "PAD Walking",
            status: "Resting",
            elapsedMs: 192_000,
            href: "/pad",
          }}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole("article", { name: "PAD Walking" })).toBeInTheDocument();
    expect(screen.getByText("Resting")).toBeInTheDocument();
    expect(screen.getByText("03:12")).toHaveAttribute("datetime", "PT192S");
    expect(screen.getByRole("link", { name: "Resume PAD Walking" })).toHaveAttribute(
      "href",
      "/pad",
    );
  });

  it("omits the timer when a session has no elapsed time", () => {
    render(
      <MemoryRouter>
        <ResumeCard
          session={{ id: "day-3", title: "Day 3", status: "4 / 7 exercises complete", href: "/resistance" }}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("4 / 7 exercises complete")).toBeInTheDocument();
    expect(document.querySelector("time")).toBeNull();
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "00:00"],
    [59_999, "00:59"],
    [480_000, "08:00"],
    [3_723_000, "1:02:03"],
    [-5_000, "00:00"],
    [Number.NaN, "00:00"],
  ])("formats %d ms as %s", (durationMs, expected) => {
    expect(formatDuration(durationMs)).toBe(expected);
  });
});
