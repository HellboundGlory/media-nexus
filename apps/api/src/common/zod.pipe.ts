// SPDX-License-Identifier: MIT
import { Injectable, type PipeTransform } from "@nestjs/common";
import type { ZodType } from "zod";
import { ApiError } from "@medianexus/shared";

/** Validates request payloads against zod schemas from @medianexus/domain/shared. */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodType) {}

  transform(value: unknown): unknown {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new ApiError({
        code: "VALIDATION_ERROR",
        message: "Request body failed validation",
        details: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    return result.data;
  }
}
