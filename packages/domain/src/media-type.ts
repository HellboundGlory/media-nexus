// SPDX-License-Identifier: MIT
import { z } from "zod";

export const mediaTypeSchema = z.enum(["movie", "series"]);
export type MediaType = z.infer<typeof mediaTypeSchema>;

/** Media kinds that can be the subject of a file/history/queue/request row.
 *  `episode` is only ever a *subject* (file/history), never a request target. */
export const subjectTypeSchema = z.enum(["movie", "series", "episode"]);
export type SubjectType = z.infer<typeof subjectTypeSchema>;

export const MEDIA_TYPES: MediaType[] = ["movie", "series"];
