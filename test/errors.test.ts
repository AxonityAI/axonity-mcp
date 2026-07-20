import { describe, expect, it } from "vitest";

import {
  AuthError,
  AxonityApiError,
  ForbiddenError,
  NotFoundError,
  VersionConflictError,
  describeDetail,
  errorForStatus,
} from "../src/errors.js";
import { errorResult } from "../src/tools/result.js";

/** What the agent actually sees — errorResult renders only `message`. */
function shown(err: unknown): string {
  return (errorResult(err) as { content: { text: string }[] }).content[0].text;
}

describe("describeDetail", () => {
  it("passes a plain string through", () => {
    expect(describeDetail("Workflow is published")).toBe("Workflow is published");
  });

  it("flattens FastAPI 422 items to field: reason", () => {
    expect(
      describeDetail([
        { loc: ["body", "capabilityTier"], msg: "Input should be 'standard'", type: "enum" },
      ]),
    ).toBe("body.capabilityTier: Input should be 'standard'");
  });

  it("joins multiple field errors", () => {
    expect(
      describeDetail([
        { loc: ["body", "name"], msg: "Field required" },
        { loc: ["body", "type"], msg: "Field required" },
      ]),
    ).toBe("body.name: Field required; body.type: Field required");
  });

  it("unwraps a nested detail object", () => {
    expect(describeDetail({ detail: "Cannot delete published workflow" })).toBe(
      "Cannot delete published workflow",
    );
  });

  it("returns undefined for nothing useful", () => {
    expect(describeDetail(undefined)).toBeUndefined();
    expect(describeDetail(null)).toBeUndefined();
    expect(describeDetail("   ")).toBeUndefined();
    expect(describeDetail([])).toBeUndefined();
  });
});

describe("errorForStatus surfaces the server detail", () => {
  it("names the offending field on a 422 — the whole point of this fix", () => {
    const err = errorForStatus(422, [
      { loc: ["body", "capabilityTier"], msg: "Input should be 'standard' or 'advanced'" },
    ]);
    expect(shown(err)).toContain("capabilityTier");
    expect(shown(err)).toContain("Input should be 'standard' or 'advanced'");
  });

  it("keeps the guidance and appends the reason on a 409", () => {
    const err = errorForStatus(409, "Cannot delete workflow: it is published");
    expect(err).toBeInstanceOf(VersionConflictError);
    expect(shown(err)).toContain("Version conflict");
    expect(shown(err)).toContain("it is published");
  });

  it("maps 404 to NotFoundError", () => {
    const err = errorForStatus(404, "Workflow not found");
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.status).toBe(404);
    expect(shown(err)).toContain("Workflow not found");
  });

  it("appends detail on 401 and 403 too", () => {
    expect(shown(errorForStatus(401, "token revoked"))).toContain("token revoked");
    const forbidden = errorForStatus(403, "This service token is read-only");
    expect(forbidden).toBeInstanceOf(ForbiddenError);
    expect(shown(forbidden)).toContain("This service token is read-only");
  });

  it("still reads cleanly when the server sends no detail", () => {
    const err = errorForStatus(500);
    expect(shown(err)).toBe("Axonity API request failed (500).");
    expect(shown(new AuthError())).not.toMatch(/undefined|\[object/);
    expect(shown(new AxonityApiError("boom", 500))).toBe("boom");
  });

  it("does not leak [object Object] for an unexpected detail shape", () => {
    expect(shown(errorForStatus(400, { code: "bad_request", hint: "check ids" }))).not.toContain(
      "[object Object]",
    );
  });
});
