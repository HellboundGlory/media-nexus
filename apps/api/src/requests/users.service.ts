// SPDX-License-Identifier: MIT
import { Inject, Injectable } from "@nestjs/common";
import { desc, eq } from "drizzle-orm";
import { ApiError, newEntityId } from "@medianexus/shared";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import { AuthService } from "../auth/auth.service";
import type { CreateSystemUser } from "@medianexus/domain";

export interface CreateUserInput extends CreateSystemUser {
  roles?: string[];
}

@Injectable()
export class UsersService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly auth: AuthService,
  ) {}

  list() {
    return this.db.select({
      id: schema.user.id, username: schema.user.username, email: schema.user.email,
      isAdmin: schema.user.isAdmin, roles: schema.user.roles, createdAt: schema.user.createdAt,
    }).from(schema.user).orderBy(desc(schema.user.createdAt));
  }

  async get(id: string) {
    const rows = await this.db.select().from(schema.user).where(eq(schema.user.id, id)).limit(1);
    if (!rows[0]) throw ApiError.notFound("user", id);
    return rows[0];
  }

  async create(input: CreateUserInput): Promise<{ id: string; rawApiKey?: string }> {
    const dup = await this.db.select().from(schema.user).where(eq(schema.user.username, input.username)).limit(1);
    if (dup[0]) throw new ApiError({ code: "CONFLICT", message: `Username "${input.username}" already exists` });
    const passwordHash = await this.auth.hashPassword(input.password);
    const now = new Date().toISOString();
    const id = newEntityId("user");
    await this.db.insert(schema.user).values({
      id,
      username: input.username,
      email: input.email ?? null,
      passwordHash,
      isAdmin: input.isAdmin ?? false,
      roles: input.roles ?? ["USER"],
      createdAt: now,
      updatedAt: now,
    });
    return { id };
  }

  async remove(id: string) {
    if (id === "user_admin") throw new ApiError({ code: "FORBIDDEN", message: "Cannot delete the bootstrap admin" });
    await this.get(id);
    await this.db.delete(schema.user).where(eq(schema.user.id, id));
    // cascade: api keys + requests + watchlists
    await this.db.delete(schema.apiKey).where(eq(schema.apiKey.userId, id));
    await this.db.delete(schema.request).where(eq(schema.request.userRequestorId, id));
    return { removed: id };
  }

  /** Create a user-scoped API key (raw shown once). */
  async createApiKey(userId: string, name = "user-key"): Promise<{ id: string; rawKey: string }> {
    await this.get(userId);
    return this.auth.createApiKey({ name, userId });
  }
}
