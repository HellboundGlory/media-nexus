// SPDX-License-Identifier: MIT
/** Structured, JSON-lines logger with secret redaction (security by default). */
const SECRET_FIELD =
  /(?:api|key|token|secret|pass|password|credential|auth|authorization|apikey)/i;

const REDACT = "[REDACTED]";

function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    if (/^(?:[A-Za-z0-9+/]{16,}={0,2}|[A-Za-z0-9_-]{16,})$/.test(value)) return REDACT;
    return value;
  }
  return value;
}

function redactObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_FIELD.test(k)) out[k] = REDACT;
    else if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) {
      out[k] = redactObject(v as Record<string, unknown>);
    } else out[k] = redactValue(v);
  }
  return out;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogContext {
  requestId?: string;
  jobId?: string;
  [k: string]: unknown;
}

export class Logger {
  constructor(
    private readonly name: string,
    private readonly level: LogLevel = "info",
    private readonly sink: (line: string) => void = (l) => process.stdout.write(l + "\n"),
  ) {}

  child(name: string): Logger {
    return new Logger(`${this.name}.${name}`, this.level, this.sink);
  }

  private write(level: LogLevel, msg: string, ctx?: LogContext) {
    if (LEVELS[level] < LEVELS[this.level]) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      logger: this.name,
      msg,
      ...redactObject((ctx ?? {}) as Record<string, unknown>),
    });
    this.sink(line);
  }

  debug(msg: string, ctx?: LogContext) { this.write("debug", msg, ctx); }
  info(msg: string, ctx?: LogContext) { this.write("info", msg, ctx); }
  warn(msg: string, ctx?: LogContext) { this.write("warn", msg, ctx); }
  error(msg: string, ctx?: LogContext) { this.write("error", msg, ctx); }
}

export const redactSecret = redactValue;
export const isSecretField = (k: string) => SECRET_FIELD.test(k);
