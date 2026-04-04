import crypto from "node:crypto";

interface LogContext {
  correlationId?: string;
  nonce?: string;
  network?: string;
  [key: string]: unknown;
}

export class Logger {
  private context: LogContext;

  constructor(context: LogContext = {}) {
    this.context = context;
  }

  child(extra: LogContext): Logger {
    return new Logger({ ...this.context, ...extra });
  }

  info(msg: string, data?: Record<string, unknown>) {
    this.write("INFO", msg, data);
  }
  warn(msg: string, data?: Record<string, unknown>) {
    this.write("WARN", msg, data);
  }
  error(msg: string, data?: Record<string, unknown>) {
    this.write("ERROR", msg, data);
  }
  debug(msg: string, data?: Record<string, unknown>) {
    if (process.env.DEBUG) this.write("DEBUG", msg, data);
  }

  private write(
    level: string,
    msg: string,
    data?: Record<string, unknown>
  ) {
    const ts = new Date().toISOString();
    const ctx = Object.keys(this.context).length
      ? ` ${JSON.stringify(this.context)}`
      : "";
    const extra = data ? ` ${JSON.stringify(data)}` : "";
    const line = `[${ts}] [${level}]${ctx} ${msg}${extra}`;

    if (level === "ERROR") console.error(line);
    else if (level === "WARN") console.warn(line);
    else console.log(line);
  }
}

export function generateCorrelationId(): string {
  return `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

export const logger = new Logger();
