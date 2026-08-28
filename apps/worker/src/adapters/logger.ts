/**
 * Structured logging.
 *
 * One JSON object per line, because the hourly report and the Grafana dashboards read
 * these rather than a human being. A log line that has to be parsed with a regular
 * expression is a log line that stops being parseable the first time someone improves
 * the wording.
 *
 * The `event` is a stable dotted name (`crawl.batch`, `generate.rejected`) and is the
 * thing dashboards group on. Fields carry the numbers. Nothing here formats prose.
 */

import type { Logger } from '../ports.js';

export type Level = 'info' | 'warn' | 'error';

export interface LogLine {
  readonly ts: string;
  readonly level: Level;
  readonly event: string;
  readonly service: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

export function formatLine(
  level: Level,
  event: string,
  fields: Readonly<Record<string, unknown>>,
  at: Date,
  service: string,
): string {
  const line: LogLine = { ts: at.toISOString(), level, event, service, fields };

  try {
    return JSON.stringify(line);
  } catch {
    // A field containing a circular reference — an error object carrying a request, most
    // often — must not take down the job that was only trying to report progress.
    return JSON.stringify({
      ts: at.toISOString(),
      level,
      event,
      service,
      fields: { unserialisable: Object.keys(fields) },
    });
  }
}

export interface LoggerOptions {
  readonly service?: string;
  readonly now?: () => Date;
  readonly write?: (line: string) => void;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const service = options.service ?? 'worker';
  const now = options.now ?? ((): Date => new Date());
  const write =
    options.write ??
    ((line: string): void => {
      process.stdout.write(`${line}\n`);
    });

  const emit =
    (level: Level) =>
    (event: string, fields: Readonly<Record<string, unknown>> = {}): void => {
      write(formatLine(level, event, fields, now(), service));
    };

  return { info: emit('info'), warn: emit('warn'), error: emit('error') };
}
