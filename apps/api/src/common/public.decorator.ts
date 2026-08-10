// SPDX-License-Identifier: MIT
import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_KEY = "isPublic";
/** Marks a route as public (no X-Api-Key required) — used ONLY for health/readiness. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
