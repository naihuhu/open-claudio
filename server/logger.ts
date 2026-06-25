// Leveled, configurable logger for Module A / Module B observability.
// Level via LOG_LEVEL env (error|warn|info|debug), default "info"; changeable at runtime
// through setLogLevel(). At INFO it prints model prompts, tool I/O and music-API I/O in full
// (the things you want to inspect when tuning prompts/tools), truncating only huge payloads.

export type Level = 'error' | 'warn' | 'info' | 'debug';

const ORDER: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };

let currentLevel: Level = normalizeLevel(process.env.LOG_LEVEL) || 'info';
// Per-field cap for serialized data; raise via LOG_MAX_FIELD if you need even more.
const MAX_FIELD = parseInt(process.env.LOG_MAX_FIELD || '8000', 10);

function normalizeLevel(v?: string): Level | null {
  if (!v) return null;
  const l = v.toLowerCase();
  return (['error', 'warn', 'info', 'debug'] as Level[]).includes(l as Level) ? (l as Level) : null;
}

export function setLogLevel(v: string): Level {
  const l = normalizeLevel(v);
  if (l) currentLevel = l;
  return currentLevel;
}
export function getLogLevel(): Level {
  return currentLevel;
}

function ts(): string {
  return new Date().toISOString();
}

function serialize(data: unknown, full = false): string {
  if (data === undefined) return '';
  if (typeof data === 'string') {
    return full || data.length <= MAX_FIELD
      ? data
      : data.slice(0, MAX_FIELD) + ` …(+${data.length - MAX_FIELD} chars)`;
  }
  let out: string;
  try {
    const seen = new WeakSet();
    out = JSON.stringify(
      data,
      (_k, v) => {
        if (typeof v === 'object' && v !== null) {
          if (seen.has(v)) return '[Circular]';
          seen.add(v);
        }
        if (typeof v === 'string' && v.length > MAX_FIELD && !full)
          return v.slice(0, MAX_FIELD) + ` …(+${v.length - MAX_FIELD})`;
        return v;
      },
      2,
    );
  } catch {
    out = String(data);
  }
  if (!full && out.length > MAX_FIELD * 2)
    out = out.slice(0, MAX_FIELD * 2) + ` …(+${out.length - MAX_FIELD * 2} chars)`;
  return out;
}

export interface Logger {
  error(msg: string, data?: unknown, opts?: { full?: boolean }): void;
  warn(msg: string, data?: unknown, opts?: { full?: boolean }): void;
  info(msg: string, data?: unknown, opts?: { full?: boolean }): void;
  debug(msg: string, data?: unknown, opts?: { full?: boolean }): void;
}

function emit(level: Level, scope: string, msg: string, data?: unknown, opts?: { full?: boolean }) {
  if (ORDER[level] > ORDER[currentLevel]) return;
  const head = `${ts()} [${level.toUpperCase()}] [${scope}] ${msg}`;
  const body = data !== undefined ? '\n' + serialize(data, opts?.full) : '';
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  sink(head + body);
}

export function makeLogger(scope: string): Logger {
  return {
    error: (m, d, o) => emit('error', scope, m, d, o),
    warn: (m, d, o) => emit('warn', scope, m, d, o),
    info: (m, d, o) => emit('info', scope, m, d, o),
    debug: (m, d, o) => emit('debug', scope, m, d, o),
  };
}

// Compact a song array for logging (keeps the fields that matter when tuning).
export function songPreview(songs: any[], limit = 30): any[] {
  return (songs || []).slice(0, limit).map((s) => ({
    id: s.id ?? s.songId,
    name: s.name ?? s.title,
    artist: s.artist ?? (s.ar || []).map((a: any) => a.name).join(', '),
    album: s.album ?? s.al?.name,
    source: s.source,
  }));
}
