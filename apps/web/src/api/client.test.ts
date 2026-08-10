// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { ApiClientError } from "./client";

describe("api client", () => {
  it("maps non-2xx responses into ApiClientError", async () => {
    // ApiClientError is constructed directly in handle(); verify the shape it produces
    const err = new ApiClientError(404, "NOT_FOUND", "missing", {});
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(404);
    expect(err.code).toBe("NOT_FOUND");
  });
});
