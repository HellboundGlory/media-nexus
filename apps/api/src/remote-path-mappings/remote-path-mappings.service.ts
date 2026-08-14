// SPDX-License-Identifier: MIT
import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { newEntityId, ApiError } from "@medianexus/shared";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import type { CreateRemotePathMapping, UpdateRemotePathMappingBody } from "@medianexus/domain";

/**
 * Remote path mapping (roadmap P1, gap report B8): a download client running in its own
 * container/host often reports a completed download's content path in its own filesystem
 * view (e.g. `/downloads/x`), which doesn't exist from MediaNexus's side. Consumed by
 * `AcquisitionService.resolveContent()` — the single place a client-reported path is
 * translated before use, keyed by which client reported it.
 */
@Injectable()
export class RemotePathMappingsService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  list() {
    return this.db.select().from(schema.remotePathMapping);
  }

  async create(input: CreateRemotePathMapping) {
    const client = await this.db.select({ id: schema.downloadClient.id }).from(schema.downloadClient)
      .where(eq(schema.downloadClient.id, input.downloadClientId)).limit(1);
    if (!client[0]) throw ApiError.notFound("download client", input.downloadClientId);

    const now = new Date().toISOString();
    const row = {
      id: newEntityId("rpm"),
      downloadClientId: input.downloadClientId,
      remotePath: input.remotePath,
      localPath: input.localPath,
      createdAt: now,
    };
    await this.db.insert(schema.remotePathMapping).values(row);
    return row;
  }

  async remove(id: string) {
    const rows = await this.db.select({ id: schema.remotePathMapping.id }).from(schema.remotePathMapping)
      .where(eq(schema.remotePathMapping.id, id)).limit(1);
    if (!rows[0]) throw ApiError.notFound("remote path mapping", id);
    await this.db.delete(schema.remotePathMapping).where(eq(schema.remotePathMapping.id, id));
    return { removed: id };
  }

  /** Edit a remote path mapping (roadmap P1, gap report C5): update remote/local path. */
  async update(id: string, input: UpdateRemotePathMappingBody) {
    const rows = await this.db.select().from(schema.remotePathMapping).where(eq(schema.remotePathMapping.id, id)).limit(1);
    if (!rows[0]) throw ApiError.notFound("remote path mapping", id);
    const merged = {
      remotePath: input.remotePath ?? rows[0].remotePath,
      localPath: input.localPath ?? rows[0].localPath,
    };
    await this.db.update(schema.remotePathMapping).set(merged).where(eq(schema.remotePathMapping.id, id));
    return { ...rows[0], ...merged };
  }

  /** All mappings for one download client, longest `remotePath` prefix first so a more
   *  specific mapping wins over a shorter overlapping one. */
  async forClient(downloadClientId: string) {
    const rows = await this.db.select().from(schema.remotePathMapping)
      .where(eq(schema.remotePathMapping.downloadClientId, downloadClientId));
    return rows.sort((a, b) => b.remotePath.length - a.remotePath.length);
  }
}
