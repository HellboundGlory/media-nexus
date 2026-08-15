// SPDX-License-Identifier: MIT
import { ConsoleLogger } from "@nestjs/common";
import { redactSecret } from "@medianexus/shared";
import type { LogBuffer } from "./log-buffer";

const REDACT = "[REDACTED]";
/**
 * Same "looks like a secret token" heuristic as `packages/shared/src/log.ts`'s `redactValue`
 * (16+ chars), but applied to token RUNS anywhere in the message, not just a whole-string match —
 * `redactSecret` (whole-string anchored) lets an embedded secret through: the bootstrap service
 * logs `"API key : mn_<key> (send as X-Api-Key header)"`, and an anchored match would leave the
 * actual key substring visible. Live scan confirmed that leak via /system/logs, so it is scrubbed
 * here. The run class is intentionally letters/digits/underscore ONLY — hyphenated, slash-separated
 * and dotted text (route paths, URLs, "download-clients", episode names) must NOT be redacted, or
 * the route-mapping boot logs become useless. This still catches API keys (`mn_<32 alnum>`), JWTs
 * and base64-ish bodies as a single high-entropy alnum run. Lossy-safe for rare long opaque tokens.
 *
 * The run must additionally contain at least one digit: real secrets in this codebase (the
 * `mn_<random>` API key, JWTs, base64 tokens) are effectively always random strings that contain
 * a digit — an all-letter run is ~99.99% not a key. Controller class names, by contrast, are
 * strict PascalCase (letters only), so without the digit check the whole Router/Resolver
 * controller-name boot messages (e.g. "CustomFormatsController {/api/v1}:") got nuked by the
 * 16-char threshold. Requiring a digit eliminates that false-positive class wholesale.
 */
const SECRET_TOKEN = /(?=[A-Za-z0-9_]*\d)[A-Za-z0-9_]{16,}/g;

function redactMessage(msg: string): string {
  const whole = (redactSecret(msg) as string) ?? msg;
  if (whole === REDACT) return whole;
  return whole.replace(SECRET_TOKEN, REDACT);
}

/**
 * Nest-compatible app logger (roadmap P3, gap report C8 logs sub-item) that does two jobs on
 * every call: (1) writes to the console EXACTLY as Nest's default ConsoleLogger does — `docker
 * logs` output must stay byte-for-byte unchanged, several ops workflows depend on it — and (2)
 * pushes the same entry into the in-memory ring buffer for the `/system/logs` + UI view.
 *
 * Applied as the app-level logger (`NestFactory.create(AppModule, { logger })`), so all the
 * existing per-class `new Logger(ClassName)` call sites transparently route through it with no
 * changes to them.
 *
 * Security: the MESSAGE is run through `redactSecret` before it is stored — an unredacted log
 * line surfaced through a new API/UI surface would be a credential-leak vector (docs/security.md
 * lists "credential leakage" in the threat model). The message string is the only place free-form
 * secret-shaped text can appear; the `context` is always a class name (never user data) and is
 * deliberately NOT redacted, since `redactSecret`/`isSecretField` would mangle long class names
 * (e.g. "DownloadClientsService") and names like "AuthService".
 */
export class RingBufferLogger extends ConsoleLogger {
  constructor(private readonly buffer: LogBuffer) {
    super();
  }

  private toMessage(message: unknown): string {
    if (typeof message === "string") return message;
    if (message instanceof Error) return message.message;
    if (typeof message === "object" && message !== null) return JSON.stringify(message);
    return String(message);
  }

  private capture(level: string, message: unknown, optionalParams: unknown[]): void {
    const context = typeof optionalParams[optionalParams.length - 1] === "string"
      ? (optionalParams[optionalParams.length - 1] as string)
      : "";
    this.buffer.append(level, context, redactMessage(this.toMessage(message)));
  }

  override log(message: unknown, ...optionalParams: unknown[]): void {
    super.log(message, ...optionalParams);
    this.capture("info", message, optionalParams);
  }

  override error(message: unknown, ...optionalParams: unknown[]): void {
    super.error(message, ...optionalParams);
    this.capture("error", message, optionalParams);
  }

  override warn(message: unknown, ...optionalParams: unknown[]): void {
    super.warn(message, ...optionalParams);
    this.capture("warn", message, optionalParams);
  }

  override debug(message: unknown, ...optionalParams: unknown[]): void {
    super.debug(message, ...optionalParams);
    this.capture("debug", message, optionalParams);
  }

  override verbose(message: unknown, ...optionalParams: unknown[]): void {
    super.verbose(message, ...optionalParams);
    this.capture("verbose", message, optionalParams);
  }
}
