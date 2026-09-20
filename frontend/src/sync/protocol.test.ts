import { describe, expect, it } from "vitest";

import { isBootstrapResponse, isChangesResponse, parsePushResponse } from "./protocol";

describe("parsePushResponse", () => {
  it("parses a well-formed mix of statuses in order", () => {
    const body = {
      results: [
        { mutation_id: "a", status: "applied" },
        { mutation_id: "b", status: "duplicate" },
        { mutation_id: "c", status: "rejected", code: "invalid_record", retryable: false, detail: "bad" },
        { mutation_id: "d", status: "retry", code: "temporarily_unavailable", retryable: true, detail: "try later" },
      ],
    };
    expect(parsePushResponse(body)).toEqual(body.results);
  });

  it("drops an entry with an unrecognised status rather than throwing, treating it as not processed", () => {
    const body = {
      results: [
        { mutation_id: "a", status: "applied" },
        { mutation_id: "b", status: "some-future-status" },
      ],
    };
    expect(parsePushResponse(body)).toEqual([{ mutation_id: "a", status: "applied" }]);
  });

  it("drops a rejected/retry entry missing its code/detail/retryable", () => {
    const body = { results: [{ mutation_id: "a", status: "rejected" }] };
    expect(parsePushResponse(body)).toEqual([]);
  });

  it("treats a malformed body as nothing processed, not a thrown error", () => {
    expect(parsePushResponse(null)).toEqual([]);
    expect(parsePushResponse("not an object")).toEqual([]);
    expect(parsePushResponse({})).toEqual([]);
    expect(parsePushResponse({ results: "not an array" })).toEqual([]);
  });
});

describe("isBootstrapResponse", () => {
  it("accepts the documented shape", () => {
    expect(
      isBootstrapResponse({
        cursor: 42,
        limits: { max_mutations_per_request: 50, max_changes_per_mutation: 500 },
        pad: {
          defaults: { speed_kmh: 5, incline_pct: 2, max_bout_seconds: 480 },
          next_session_settings: {
            source: "previous_session",
            walking_session_id: "session-1",
            speed_kmh: 5.65,
            incline_pct: 2,
            max_bout_seconds: 445,
          },
        },
      }),
    ).toBe(true);
  });

  it("rejects a missing or malformed field", () => {
    expect(isBootstrapResponse(null)).toBe(false);
    expect(isBootstrapResponse({})).toBe(false);
    expect(
      isBootstrapResponse({
        cursor: 0,
        limits: { max_mutations_per_request: 50, max_changes_per_mutation: 500 },
        pad: { defaults: { speed_kmh: 5, incline_pct: 2, max_bout_seconds: 480 }, next_session_settings: { source: "unknown" } },
      }),
    ).toBe(false);
  });
});

describe("isChangesResponse", () => {
  it("accepts the documented shape", () => {
    expect(
      isChangesResponse({
        changes: [
          {
            store: "walking_bouts",
            entity_type: "walking_bout",
            entity_id: "bout-1",
            change_seq: 41,
            record: { id: "bout-1", deleted_at: null },
          },
        ],
        cursor: 41,
        has_more: true,
      }),
    ).toBe(true);
  });

  it("rejects an unknown store or a malformed record", () => {
    expect(
      isChangesResponse({
        changes: [
          { store: "not_a_real_store", entity_type: "x", entity_id: "1", change_seq: 1, record: { id: "1" } },
        ],
        cursor: 1,
        has_more: false,
      }),
    ).toBe(false);
    expect(isChangesResponse({ changes: [{}], cursor: 1, has_more: false })).toBe(false);
  });
});
