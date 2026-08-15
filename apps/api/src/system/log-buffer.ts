// SPDX-License-Identifier: MIT
/**
 * Bounded in-memory ring buffer of recent log entries (roadmap P3, gap report C8 logs sub-item).
 *
 * Deliberately NOT persisted — a restart clears it. That is a scoping decision for this LAN app:
 * `docker logs` already provides the unredacted, unbounded history; this buffer is a convenience
 * "what just happened" view for the UI, not a forensic log store.
 */
export interface LogEntry {
  /** ISO timestamp of when the line was logged. */
  timestamp: string;
  /** Nest logger level: debug | info | warn | error | verbose. */
  level: string;
  /** Logging context — normally the class name of the `new Logger(ClassName)` that emitted it. */
  context: string;
  /** The (redacted) log message text. */
  message: string;
}

const DEFAULT_CAPACITY = 2000;

export class LogBuffer {
  private readonly entries: LogEntry[] = [];

  constructor(private readonly capacity = DEFAULT_CAPACITY) {}

  append(level: string, context: string, message: string): LogEntry {
    const entry: LogEntry = { timestamp: new Date().toISOString(), level, context, message };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
    return entry;
  }

  /** Most-recent-first view of the buffer, optionally filtered by exact level and substring search. */
  latest(limit: number, level?: string, search?: string): LogEntry[] {
    let result = this.entries;
    if (level) {
      const want = level.toLowerCase();
      result = result.filter((e) => e.level === want);
    }
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((e) => e.context.toLowerCase().includes(q) || e.message.toLowerCase().includes(q));
    }
    return result.slice(-limit).reverse();
  }
}

/** Module-level singleton shared by the custom Nest logger (main.ts) and the /system/logs endpoint. */
export const logBuffer = new LogBuffer();
