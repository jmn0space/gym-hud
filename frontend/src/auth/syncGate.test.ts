import { describe, expect, it } from "vitest";

import type { AuthStatus } from "./AuthProvider";
import { canSync } from "./syncGate";

const STATUSES: AuthStatus[] = ["checking", "login-required", "unverified", "authenticated", "expired"];

describe("canSync", () => {
  it("is true only for authenticated + online", () => {
    expect(canSync("authenticated", true)).toBe(true);
  });

  it.each(STATUSES.filter((status) => status !== "authenticated"))(
    "is false while online for status %s",
    (status) => {
      expect(canSync(status, true)).toBe(false);
    },
  );

  it.each(STATUSES)("is false while offline for status %s, including authenticated", (status) => {
    expect(canSync(status, false)).toBe(false);
  });
});
