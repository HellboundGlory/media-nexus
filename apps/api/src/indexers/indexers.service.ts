// SPDX-License-Identifier: MIT
import { Inject, Injectable, Logger } from "@nestjs/common";
import { asc, desc, eq, sql as dsql } from "drizzle-orm";
import { ApiError, newEntityId } from "@medianexus/shared";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import type { Release, CreateIndexer, UpdateIndexerBody } from "@medianexus/domain";
import { ProvidersService } from "../providers/demo.providers";
import { redactSettings, REDACTED } from "../common/redact";
import { tagApplies } from "../common/tags";
import { EventsService } from "../events/events.service";
import { EventTypes } from "@medianexus/events";
import { z } from "zod";
import { newznabSettingsSchema, torznabSettingsSchema, memoryIndexerSettingsSchema } from "@medianexus/integrations";
import { ConfigService } from "../system/config.service";
import { join, resolve } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { episodeQueryTag } from "@medianexus/domain";
import { parseCardigannYaml, cardigannSettingsSchema, cardigannDefinitionStatus } from "@medianexus/integrations";
import { DecisionService } from "../decision/decision.service";
import { ProviderStatusService } from "../providers/provider-status.service";
import { cardigannSecretFields, decryptFields, decryptSessionValue, encryptFields, encryptSessionValue, getProviderSecret, INDEXER_SETTINGS_SECRET_FIELDS, PROXY_SECRET_FIELDS } from "../secrets/provider-secrets";

const settingsSchemas: Record<string, z.ZodType> = {
  memory: memoryIndexerSettingsSchema,
  newznab: newznabSettingsSchema,
  torznab: torznabSettingsSchema,
};

@Injectable()
export class IndexersService {
  private readonly logger = new Logger(IndexersService.name);
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly providers: ProvidersService,
    private readonly events: EventsService,
    private readonly config: ConfigService,
    private readonly decisions: DecisionService,
    private readonly status: ProviderStatusService,
  ) {}

  async definitions() {
    const rows = await this.db.select().from(schema.indexerDefinition).orderBy(asc(schema.indexerDefinition.name));
    // "memory" stays seeded (test infra creates indexers against it) but is never real —
    // never surface it to a real client browsing definitions.
    return rows.filter((def) => def.implementation !== "memory").map((def) => {
      let settingsSchema: { name: string; label?: string; type: string; default?: string | number | boolean; required: boolean; options?: string[] }[] | undefined;
      if (def.implementation === "cardigann" && def.cardigannYml) {
        try {
          const parsed = parseCardigannYaml(def.cardigannYml);
          settingsSchema = parsed.settings?.map((s) => ({ name: s.name, label: s.label, type: s.type, default: s.default, required: Boolean(s.required), options: s.options }));
        } catch { /* leave undefined */ }
      }
      return { ...def, settingsSchema };
    });
  }

  /** Create a custom Cardigann definition (validated YAML) → selectable like built-ins. */
  async createDefinition(input: { key: string; name: string; protocol: "usenet" | "torrent"; cardigannYml: string }) {
    let parsed: ReturnType<typeof parseCardigannYaml>;
    try {
      parsed = parseCardigannYaml(input.cardigannYml);
      // D4 Stage 1/3: a definition this interpreter can't actually execute (unimplemented
      // filter, unknown template function, or a captcha gate) is rejected at validation time
      // so a broken indexer is never silently exposed as usable.
      const status = cardigannDefinitionStatus(parsed);
      if (!status.supported) {
        throw new ApiError({
          code: "VALIDATION_ERROR",
          message: `Unsupported Cardigann definition: ${status.reasons.join("; ")}`,
        });
      }
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError({ code: "VALIDATION_ERROR", message: `Invalid Cardigann YAML: ${(err as Error).message}` });
    }
    const capabilities = { search: true, cardigannStatus: cardigannDefinitionStatus(parsed) };
    const existing = await this.db.select().from(schema.indexerDefinition).where(eq(schema.indexerDefinition.key, input.key)).limit(1);
    if (existing[0]) {
      // Security guard (Plan-agent D4 flag): a user can't overwrite a *built-in* definition
      // on a key collision — custom definitions must use their own key.
      if (existing[0].builtIn) {
        throw new ApiError({
          code: "CONFLICT",
          message: `Cannot overwrite built-in indexer definition "${input.key}" — choose a different key for a custom definition`,
        });
      }
      await this.db.update(schema.indexerDefinition)
        .set({ name: input.name, protocol: input.protocol, cardigannYml: input.cardigannYml, capabilities })
        .where(eq(schema.indexerDefinition.key, input.key));
      return { updated: input.key };
    }
    const now = new Date().toISOString();
    await this.db.insert(schema.indexerDefinition).values({
      id: newEntityId("idef"),
      key: input.key,
      name: input.name,
      protocol: input.protocol,
      implementation: "cardigann",
      builtIn: false,
      capabilities,
      categoryIds: [],
      cardigannYml: input.cardigannYml,
      createdAt: now,
    });
    return { created: input.key };
  }

  list() {
    return this.db.select().from(schema.indexer).orderBy(desc(schema.indexer.createdAt)).then((rows) =>
      rows.map((r) => ({ ...r, settings: redactSettings(r.settings), proxy: r.proxy ? redactSettings(r.proxy) : null })),
    );
  }

  async get(id: string) {
    const rows = await this.db.select().from(schema.indexer).where(eq(schema.indexer.id, id)).limit(1);
    if (!rows[0]) throw ApiError.notFound("indexer", id);
    // J9: never return stored ciphertext (or plaintext) for credential fields — redact,
    // matching `list()`. Internal callers (test/remove) only use `.id`, so this is safe.
    return { ...rows[0], settings: redactSettings(rows[0].settings), proxy: rows[0].proxy ? redactSettings(rows[0].proxy) : null };
  }

  async create(input: CreateIndexer) {
    const def = await this.db.select().from(schema.indexerDefinition).where(eq(schema.indexerDefinition.key, input.definitionKey)).limit(1);
    if (!def[0]) throw new ApiError({ code: "VALIDATION_ERROR", message: `Unknown indexer definition key "${input.definitionKey}"` });
    const impl = def[0].implementation;

    let parsedSettings: Record<string, unknown>;
    let secretFields: string[];
    if (impl === "cardigann") {
      if (!def[0].cardigannYml) throw new ApiError({ code: "VALIDATION_ERROR", message: "Cardigann definition has no YAML body" });
      const parsed = parseCardigannYaml(def[0].cardigannYml);
      const res = cardigannSettingsSchema(parsed).safeParse(input.settings);
      if (!res.success) throw new ApiError({ code: "VALIDATION_ERROR", message: `Invalid settings for ${def[0].name}`, details: res.error.issues });
      parsedSettings = res.data as Record<string, unknown>;
      secretFields = cardigannSecretFields(parsed);
    } else {
      const s = settingsSchemas[impl];
      if (!s) {
        throw new ApiError({ code: "VALIDATION_ERROR", message: `Indexer implementation "${impl}" not available yet` });
      }
      const parsed = s.safeParse(input.settings);
      if (!parsed.success) {
        throw new ApiError({ code: "VALIDATION_ERROR", message: `Invalid settings for ${impl}`, details: parsed.error.issues });
      }
      parsedSettings = parsed.data as Record<string, unknown>;
      secretFields = INDEXER_SETTINGS_SECRET_FIELDS[impl] ?? [];
    }

    const now = new Date().toISOString();
    const secret = getProviderSecret();
    const row = {
      id: newEntityId("idx"),
      definitionKey: input.definitionKey,
      name: input.name,
      protocol: input.protocol,
      enabled: input.enabled ?? true,
      implementation: impl,
      // J9: store credentials encrypted at rest (decrypted on read when providers are built).
      settings: encryptFields(parsedSettings, secretFields, secret),
      proxy: input.proxy ? encryptFields(input.proxy, PROXY_SECRET_FIELDS, secret) : null,
      priority: input.priority ?? 25,
      status: "ok",
      tags: input.tags ?? [],
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(schema.indexer).values(row);
    // J9: never return stored ciphertext for credential fields — redact, matching `list()`.
    return { ...row, settings: redactSettings(row.settings), proxy: row.proxy ? redactSettings(row.proxy) : null };
  }

  /** Secret leaf fields for an indexer row (cardigann needs its YAML definition). */
  private async indexerSecretFields(row: { implementation: string; definitionKey: string }): Promise<string[]> {
    if (row.implementation === "cardigann") {
      const def = (await this.db.select().from(schema.indexerDefinition).where(eq(schema.indexerDefinition.key, row.definitionKey)).limit(1))[0];
      return cardigannSecretFields(def?.cardigannYml ? parseCardigannYaml(def.cardigannYml) : undefined);
    }
    return INDEXER_SETTINGS_SECRET_FIELDS[row.implementation] ?? [];
  }

  /**
   * Edit an indexer (roadmap P1, gap report C5). Partial body; `settings`/`proxy` are
   * J9-aware: the stored (encrypted) secrets are decrypted, the client's plaintext values
   * merged over them, the merged settings re-validated against the provider schema, then
   * re-encrypted before write — so an omitted or `[REDACTED]` secret is preserved and a new
   * secret never lands in plaintext. `proxy: null` clears the proxy config. Returns the
   * redacted row (matching create()/get()). */
  async update(id: string, input: UpdateIndexerBody) {
    const rows = await this.db.select().from(schema.indexer).where(eq(schema.indexer.id, id)).limit(1);
    if (!rows[0]) throw ApiError.notFound("indexer", id);
    const existing = rows[0];
    const secret = getProviderSecret();
    const secretFields = await this.indexerSecretFields(existing);

    let settings = existing.settings;
    if (input.settings) {
      const decoded = decryptFields((existing.settings ?? {}) as Record<string, unknown>, secretFields, secret);
      const provided = input.settings as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...decoded, ...provided };
      for (const f of secretFields) if (provided[f] === REDACTED) merged[f] = decoded[f];
      if (existing.implementation === "cardigann") {
        const def = (await this.db.select().from(schema.indexerDefinition).where(eq(schema.indexerDefinition.key, existing.definitionKey)).limit(1))[0];
        if (!def?.cardigannYml) throw new ApiError({ code: "VALIDATION_ERROR", message: "Cardigann definition has no YAML body" });
        const res = cardigannSettingsSchema(parseCardigannYaml(def.cardigannYml)).safeParse(merged);
        if (!res.success) throw new ApiError({ code: "VALIDATION_ERROR", message: `Invalid settings for ${existing.name}`, details: res.error.issues });
        settings = encryptFields(res.data as Record<string, unknown>, secretFields, secret);
      } else {
        const s = settingsSchemas[existing.implementation];
        if (!s) throw new ApiError({ code: "VALIDATION_ERROR", message: `Indexer implementation "${existing.implementation}" not available yet` });
        const res = s.safeParse(merged);
        if (!res.success) throw new ApiError({ code: "VALIDATION_ERROR", message: `Invalid settings for ${existing.implementation}`, details: res.error.issues });
        settings = encryptFields(res.data as Record<string, unknown>, secretFields, secret);
      }
    }

    let proxy = existing.proxy;
    if (input.proxy === null) {
      proxy = null;
    } else if (input.proxy) {
      const decodedProxy = (existing.proxy ? decryptFields(existing.proxy as Record<string, unknown>, PROXY_SECRET_FIELDS, secret) : {}) as Record<string, unknown>;
      const providedProxy = input.proxy as Record<string, unknown>;
      const mergedProxy: Record<string, unknown> = { ...decodedProxy, ...providedProxy };
      if (providedProxy.password === REDACTED) mergedProxy.password = decodedProxy.password;
      proxy = encryptFields(mergedProxy, PROXY_SECRET_FIELDS, secret) as typeof existing.proxy;
    }

    const mergedRow = {
      name: input.name ?? existing.name,
      enabled: input.enabled ?? existing.enabled,
      priority: input.priority ?? existing.priority,
      tags: input.tags ?? existing.tags,
      settings,
      proxy,
      updatedAt: new Date().toISOString(),
    };
    await this.db.update(schema.indexer).set(mergedRow).where(eq(schema.indexer.id, id));
    const updated = { ...existing, ...mergedRow };
    return {
      ...updated,
      settings: redactSettings(updated.settings as Record<string, unknown>),
      proxy: updated.proxy ? redactSettings(updated.proxy as Record<string, unknown>) : null,
    };
  }

  /** Run a live health check on one configured indexer and persist the result.
   *  This is the explicit recovery path (B10): deliberately ungated by backoff — a manual
   *  test must reach a backed-off/auto-disabled provider — and it is the single writer of
   *  `indexer.status` via ProviderStatusService.recordSuccess()/recordFailure(). */
  async test(id: string) {
    const row = await this.get(id);
    const { provider } = await this.bestProviderFor(row);
    if (!provider) throw new ApiError({ code: "UNPROCESSABLE", message: "No provider for this indexer" });
    const health = await provider.healthcheck();
    const now = new Date().toISOString();
    if (health.ok) {
      await this.status.recordSuccess("indexer", id);
    } else {
      await this.status.recordFailure("indexer", id, new Error(health.message ?? "healthcheck failed"));
    }
    // Capability detection (roadmap D1): a healthy indexer also advertises what it
    // supports via `t=caps`. Best-effort — a detection failure never fails the test — and
    // stored per-indexer (a shared definition's instances can advertise different caps).
    let capabilities: Record<string, unknown> | null = null;
    if (health.ok && provider.capabilities) {
      try {
        capabilities = await provider.capabilities();
      } catch (err) {
        this.logger.warn(`capability detection failed for "${row.name}": ${(err as Error).message}`);
      }
    }
    // lastSyncAt is the manual "ran a healthcheck" timestamp — distinct from the
    // escalations/backoff tracked in provider_status, and only meaningful here.
    await this.db.update(schema.indexer)
      .set({ lastSyncAt: now, capabilities, updatedAt: now })
      .where(eq(schema.indexer.id, id));
    if (!health.ok) {
      this.events.publish(EventTypes.IndexerFailed, { indexerId: id, error: health.message ?? "healthcheck failed" }, { aggType: "indexer", aggId: id });
    }
    return { id, ok: health.ok, latencyMs: health.latencyMs, message: health.message, capabilities };
  }

  /** Health-check every enabled indexer (used by the discovery.indexerRefresh job). */
  async refreshAll(): Promise<{ checked: number; ok: number; failed: number }> {
    const configured = await this.providers.configuredIndexers();
    let ok = 0; let failed = 0;
    for (const { row } of configured) {
      const r = await this.test(row.id).catch((e) => ({ ok: false as const, message: (e as Error).message }));
      if (r.ok) ok++; else failed++;
    }
    return { checked: configured.length, ok, failed };
  }

  /** Per-indexer acquisition stats (from history). */
  async statistics() {
    const grabs = await this.db
      .select({
        indexerId: dsql`json_extract(${schema.historyEntry.data}, '$.indexerId')`,
        createdAt: schema.historyEntry.createdAt,
      })
      .from(schema.historyEntry)
      .where(eq(schema.historyEntry.action, "grabbed"))
      .orderBy(desc(schema.historyEntry.createdAt))
      .limit(2000);
    const rows = await this.list();
    const stats = rows.map((r) => {
      const mine = grabs.filter((g) => String(g.indexerId) === String(r.id));
      const total = mine.length;
      const last = mine[0]?.createdAt ?? null;
      return { id: r.id, name: r.name, implementation: r.implementation, status: r.status, lastError: r.lastError, grabs: total, lastGrabAt: last };
    });
    return stats;
  }

  private async bestProviderFor(row: { id: string }) {
    const configured = await this.providers.configuredIndexers();
    return configured.find((c) => c.row.id === row.id) ?? { row, provider: null as never };
  }

  async remove(id: string) {
    await this.get(id);
    await this.db.delete(schema.indexer).where(eq(schema.indexer.id, id));
    await this.status.clearProvider("indexer", id);
    return { removed: id };
  }

  /** Search all enabled indexers through their providers (real HTTP for newznab/torznab).
   *  For series, an optional episode target augments the query with an SxxExx tag.
   *  Every release carries the decision engine's verdict (roadmap P0.3, gap report C3) —
   *  interactive search can show *why* a release is greyed out, and RssSyncService reuses
   *  these decisions instead of re-evaluating each candidate itself. */
  async search(input: { mediaType: "movie" | "series"; mediaId: string; query?: string; seasons?: number[]; episodes?: number[]; limit?: number }) {
    const query = this.buildQuery(input.query, input.seasons, input.episodes);
    // ID-based lookup (roadmap D1): resolve the title's stable external ids so providers
    // can use t=tvsearch / t=movie instead of fuzzy t=search when available; its tags
    // drive tag-scoped indexer search (roadmap P2, gap C6).
    const { tags, ...ids } = await this.lookupSearchIds(input.mediaType, input.mediaId);
    const results = await this.fetchReleases(
      query, input.limit ?? 20, input.mediaType, input.seasons?.[0], input.episodes?.[0], ids, tags,
    );
    const decisions = await this.decisions.evaluateMany(input.mediaType, input.mediaId, results);
    const releases = results.map((r, i) => ({ ...r, decision: decisions[i] }));
    return { mediaType: input.mediaType, mediaId: input.mediaId, query, releases };
  }

  /** Load the stable external ids + tags a provider needs for ID search / tag scoping. */
  private async lookupSearchIds(
    mediaType: "movie" | "series", mediaId: string,
  ): Promise<{ tvdbId?: number; imdbId?: string; tmdbId?: number; tags: string[] }> {
    if (mediaType === "series") {
      const rows = await this.db.select().from(schema.series).where(eq(schema.series.id, mediaId)).limit(1);
      const r = rows[0];
      return { tvdbId: r?.tvdbId ?? undefined, imdbId: r?.imdbId ?? undefined, tmdbId: r?.tmdbId ?? undefined, tags: r?.tags ?? [] };
    }
    const rows = await this.db.select().from(schema.movie).where(eq(schema.movie.id, mediaId)).limit(1);
    const r = rows[0];
    return { imdbId: r?.imdbId ?? undefined, tmdbId: r?.tmdbId ?? undefined, tags: r?.tags ?? [] };
  }

  /** The media's tags, for tag-based download-client routing at grab time (gap C6). */
  private async mediaTagsFor(mediaType: "movie" | "series", mediaId: string): Promise<string[]> {
    const table = mediaType === "series" ? schema.series : schema.movie;
    const col = mediaType === "series" ? schema.series.id : schema.movie.id;
    const rows = await this.db.select().from(table).where(eq(col, mediaId)).limit(1);
    return rows[0]?.tags ?? [];
  }

  /** Category-only "recent releases" poll across every configured indexer (roadmap D2,
   *  real RSS sync) — an empty query with no target yet, so no decision is attached here;
   *  the caller (RssSyncService.runFeedPoll()) resolves a target per release first via
   *  reverse-matching, then evaluates a decision for just the ones that matched. Neither
   *  Newznab/Torznab nor Cardigann read `mediaType`/`categories` from search params — an
   *  indexer's category list is fixed at indexer-setup time — so this doesn't need to know
   *  movie-vs-series in advance; `parseEpisodeRelease()` gives that signal per release. */
  async pollRecent(limitPerIndexer = 100): Promise<Release[]> {
    return this.fetchReleases("", limitPerIndexer);
  }

  /** Fan out a query over every configured indexer, collecting whatever comes back.
   *  Shared by search() (query-scoped, decision-attached) and pollRecent() (empty query,
   *  no decision — the target isn't known yet). Each indexer is gated on backoff /
   *  rate-limit (B10): a dead indexer is skipped instead of adding its full HTTP timeout
   *  to every search/poll, and a success clears its failure state. */
  private async fetchReleases(
    query: string,
    limit: number,
    mediaType: "movie" | "series" = "movie",
    season?: number,
    episode?: number,
    ids?: { tvdbId?: number; imdbId?: string; tmdbId?: number },
    mediaTags?: string[],
  ): Promise<Release[]> {
    const configured = await this.providers.configuredIndexers();
    const results: Release[] = [];
    for (const { row, provider } of configured) {
      // Tag-scoped search (roadmap P2, gap C6): a tagged indexer only serves media that
      // shares a tag; untagged indexers serve everything. Only applied when a media
      // target is in scope (search) — the category-only RSS poll (pollRecent, mediaTags
      // undefined) stays unscoped across every indexer.
      if (mediaTags !== undefined && !tagApplies(row.tags, mediaTags)) continue;
      const gate = await this.status.beforeCall("indexer", row.id, query ? "query" : "poll");
      if (gate.skip) continue;
      try {
        const releases = await provider.search({ mediaType, query, categories: undefined, limit, season, episode, ...ids });
        await this.status.recordSuccess("indexer", row.id);
        // D4 Stage 2: persist a Cardigann login-session update (encrypted at rest) so a
        // freshly established/refreshed session survives the next search (indexers are rebuilt
        // from the DB each call, so the session must round-trip through the column).
        if (row.implementation === "cardigann" && provider.session) {
          const secret = getProviderSecret();
          const stored = decryptSessionValue(row.sessionState ?? undefined, secret);
          if (provider.session !== stored) {
            const encrypted = encryptSessionValue(provider.session, secret) ?? null;
            await this.db.update(schema.indexer)
              .set({ sessionState: encrypted, updatedAt: new Date().toISOString() })
              .where(eq(schema.indexer.id, row.id));
            row.sessionState = encrypted;
          }
        }
        for (const r of releases) {
          results.push({ ...r, indexerId: row.id, indexerName: row.name });
        }
      } catch (err) {
        await this.status.recordFailure("indexer", row.id, err);
        this.events.publish(EventTypes.IndexerFailed, { indexerId: row.id, error: (err as Error).message }, { aggType: "indexer", aggId: row.id });
      }
    }
    return results;
  }

  private buildQuery(base: string | undefined, seasons?: number[], episodes?: number[]): string {
    const parts = [base?.trim()].filter(Boolean);
    const s = seasons?.[0];
    const e = episodes?.[0];
    if (s !== undefined && e !== undefined) parts.push(episodeQueryTag(s, e));
    return parts.join(" ");
  }

  /** Grab a release: choose a download client by protocol, add it, and mirror into the unified queue.
   *  When `release` is supplied (RSS auto-grab) the search round-trip to re-resolve the id is skipped. */
  async grab(input: { mediaType: "movie" | "series"; mediaId: string; releaseId: string; indexerId?: string; downloadClientId?: string; release?: Release }) {
    let release: Release | null = input.release ?? null;
    if (!release) {
      // Re-run the search (using the media title as the query) to resolve the release id.
      const configured = await this.providers.configuredIndexers();
      const query = await this.mediaTitle(input.mediaType, input.mediaId);
      for (const { row, provider } of configured) {
        let found: Release | null = null;
        if (row.id === input.indexerId || !input.indexerId) {
          const gate = await this.status.beforeCall("indexer", row.id, "grab");
          if (gate.skip) continue;
          try {
            const releases = await provider.search({ mediaType: input.mediaType, query });
            found = releases.find((r) => r.id === input.releaseId) ?? null;
            if (!found) {
              // fall back to catalog/RSS search (some providers only return the release there)
              const all = await provider.search({ mediaType: input.mediaType, query: "" });
              found = all.find((r) => r.id === input.releaseId) ?? null;
            }
            if (found) await this.status.recordSuccess("indexer", row.id);
          } catch (err) {
            await this.status.recordFailure("indexer", row.id, err);
          }
        }
        if (found) { release = { ...found, indexerId: row.id, indexerName: row.name }; break; }
      }
      if (!release) throw ApiError.notFound("release", input.releaseId);
    }

    // Re-evaluate at grab time even if the caller already saw a decision from search() —
    // a manual grab may use a stale client-side result, and RssSyncService always re-checks
    // here too rather than trusting its own earlier evaluation blindly.
    const decision = await this.decisions.evaluate(input.mediaType, input.mediaId, release);
    if (!decision.approved) {
      throw new ApiError({
        code: "CONFLICT",
        message: `"${release.title}" was rejected: ${decision.rejections.map((r) => r.message).join("; ")}`,
      });
    }

    const client = await this.providers.pickDownloadClient(release.protocol as "usenet" | "torrent", input.downloadClientId, await this.mediaTagsFor(input.mediaType, input.mediaId));
    const clientId = client.row?.id ?? null;
    let downloadId: string;
    try {
      const res = await client.provider.addRelease({ release, category: input.mediaType });
      downloadId = res.downloadId;
      await this.status.recordSuccess("downloadClient", clientId);
    } catch (err) {
      await this.status.recordFailure("downloadClient", clientId, err);
      throw err;
    }

    const now = new Date().toISOString();
    const queueId = newEntityId("q");
    const data: Record<string, unknown> = {
      releaseId: release.id,
      releaseTitle: release.title,
      indexerId: input.indexerId ?? release.indexerId,
      downloadId,
      quality: release.quality,
      protocol: release.protocol,
      size: release.size,
      category: input.mediaType,
    };
    // memory download client (test infra only): create a placeholder "downloaded" file so the importer has something to move
    if (client.row?.implementation === "memory") {
      const cfg = await this.config.get();
      const downloadsRoot = cfg["paths.downloads"] || resolve(process.cwd(), "data", "downloads");
      const dir = join(downloadsRoot, safePlaceholder(release.title));
      mkdirSync(dir, { recursive: true });
      const placeholder = join(dir, `${safePlaceholder(release.title)}.mkv`);
      writeFileSync(placeholder, Buffer.alloc(1024));
      data.completedPath = placeholder;
    }

    this.db.transaction((tx) => {
      tx.insert(schema.downloadQueueEntry).values({
        id: queueId,
        mediaType: input.mediaType,
        mediaId: input.mediaId,
        downloadClientId: client.row?.id ?? null,
        downloadId,
        title: release!.title,
        status: "downloading",
        progress: 5,
        size: release!.size,
        remainingTime: null,
        data,
        addedAt: now,
        updatedAt: now,
      }).run();
      tx.insert(schema.historyEntry).values({
        id: newEntityId("hist"),
        mediaType: input.mediaType,
        mediaId: input.mediaId,
        action: "grabbed",
        data,
        createdAt: now,
      }).run();
    });
    const agg = { aggType: input.mediaType, aggId: input.mediaId };
    this.events.publish(EventTypes.ReleaseGrabbed, { releaseId: release.id, title: release.title, downloadId, mediaType: input.mediaType, mediaId: input.mediaId }, agg);
    this.events.publish(EventTypes.DownloadStarted, { downloadId, title: release.title }, agg);
    return { queueId, downloadId, client: client.row?.name ?? "memory", release: { id: release.id, title: release.title, quality: release.quality } };
  }

  private async mediaTitle(mediaType: "movie" | "series", mediaId: string): Promise<string> {
    if (mediaType === "movie") {
      const rows = await this.db.select({ t: schema.movie.title }).from(schema.movie).where(eq(schema.movie.id, mediaId)).limit(1);
      return rows[0]?.t ?? "";
    }
    const rows = await this.db.select({ t: schema.series.title }).from(schema.series).where(eq(schema.series.id, mediaId)).limit(1);
    return rows[0]?.t ?? "";
  }
}

function safePlaceholder(s: string): string {
  return s.replace(/[^A-Za-z0-9 _()[\]-]/g, "").trim() || "download";
}
