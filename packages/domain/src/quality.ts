// SPDX-License-Identifier: MIT
import { z } from "zod";

/** Quality sources (subset sufficient for the scaffold; extends later). */
export const qualitySourceSchema = z.enum([
  "unknown", "sd", "hdtv", "web", "bluray", "dvd",
]);
export const resolutionSchema = z.enum([
  "unknown", "480p", "576p", "720p", "1080p", "2160p",
]);

export const qualitySchema = z.object({
  source: qualitySourceSchema.default("unknown"),
  resolution: resolutionSchema.default("unknown"),
  edition: z.string().default(""),
});
export type Quality = z.infer<typeof qualitySchema>;

export const qualityProfileSchema = z.object({
  name: z.string().min(1),
  allowed: z.array(z.object({
    source: qualitySourceSchema,
    resolution: resolutionSchema,
  })).min(1, "at least one allowed quality"),
  cutoff: z.object({ source: qualitySourceSchema, resolution: resolutionSchema }),
  upgradeAllowed: z.boolean().default(true),
  language: z.string().default("en"),
  isDefault: z.boolean().default(false),
});
export type QualityProfileBody = z.infer<typeof qualityProfileSchema>;

/** Compare two qualities; returns >0 if a is better than b. */
export const sourceRank: Record<string, number> = {
  unknown: 0, sd: 1, hdtv: 2, web: 3, dvd: 4, bluray: 5,
};
export const resolutionRank: Record<string, number> = {
  unknown: 0, "480p": 1, "576p": 2, "720p": 3, "1080p": 4, "2160p": 5,
};

export function qualityRank(q: Quality): number {
  return sourceRank[q.source] * 10 + resolutionRank[q.resolution];
}

/** A configured profile allows the listed qualities (used by profile checks, M1+). */
export function qualitySatisfies(profile: { allowed: Quality[] }, q: Quality): boolean {
  return profile.allowed.some(
    (a) => a.source === q.source && a.resolution === q.resolution,
  );
}
