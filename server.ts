import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import dotenv from 'dotenv';
import neteaseApi from '@neteasecloudmusicapienhanced/api';
import { createServer as createViteServer } from 'vite';
import { ChatOpenAI } from '@langchain/openai';
import { BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';

import { Readable } from 'stream';
// SPEC module implementations
import {
  initNeteaseConfig,
  resolvePlayUrl,
  getDefaultRecommendations,
  getSongTags,
  getLyric,
  getPersonalFm,
  isSongLiked,
  setSongLike,
} from './server/netease';
import type { Track } from './server/netease';
import { toTrack } from './server/musicTools';
import { makeLogger, setLogLevel, getLogLevel } from './server/logger';
import * as Taste from './server/taste';
import * as Tts from './server/ttsAdapter';
import * as MusicAgent from './server/musicAgent';

dotenv.config();

// Fresh checkout with no .env? Fall back to .env.example so the app still boots with sane defaults,
// and loadConfig() then SEEDS a fresh config.json from those values on first run. A real .env always
// wins — the example is only loaded when .env is genuinely absent (dotenv also never overrides vars
// already set in the real environment).
{
  const envPath = path.join(process.cwd(), '.env');
  const envExamplePath = path.join(process.cwd(), '.env.example');
  if (!fs.existsSync(envPath) && fs.existsSync(envExamplePath)) {
    dotenv.config({ path: envExamplePath });
    console.log('[Config] No .env found — seeded environment from .env.example');
  }
}

const app = express();
const log = makeLogger('Server');
console.log(
  `[Server] log level = ${getLogLevel()} (set LOG_LEVEL=error|warn|info|debug, or POST /api/loglevel)`,
);

// Server host/port (override via env)
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

// Root for bundled, read-only app assets (built frontend in dist/, prompt
// templates). Defaults to the working dir (dev / `npm start`); the Electron
// desktop build sets CLAUDIO_APP_ROOT to the packaged app dir, where cwd can't
// point (assets live inside app.asar). Distinct from CLAUDIO_DIR, which is the
// writable user-data dir.
const APP_ROOT = process.env.CLAUDIO_APP_ROOT || process.cwd();

// Configuration and Persistence Directory Constants
// CLAUDIO_DIR is the base directory for all persisted data; override via env.
// MUSIC_DIR defaults to CLAUDIO_DIR (no separate "music" sub-layer); override via env.
const CLAUDIO_DIR = process.env.CLAUDIO_DIR || path.join(os.homedir(), '.claudio');
const MUSIC_DIR = process.env.CLAUDIO_MUSIC_DIR || CLAUDIO_DIR;
const CONFIG_FILE_PATH = path.join(CLAUDIO_DIR, 'config.json');
// UI preferences (theme, clock font, …) live in their own file so they stay clear of the
// env-priority merge logic that governs config.json (llm/tts credentials).
const PREFERENCES_FILE_PATH = path.join(CLAUDIO_DIR, 'preferences.json');
const SESSION_FILE_PATH = path.join(MUSIC_DIR, 'user_session.json');
// Chat history is now JSONL (one message per line) so we can append a single line per turn
// instead of rewriting the whole file, and tail-load the latest N on open. The legacy single-JSON
// file is migrated to JSONL on first boot (see loadChatHistory).
const CHAT_HISTORY_FILE_PATH = path.join(CLAUDIO_DIR, 'chat_history.jsonl');
const CHAT_HISTORY_LEGACY_PATH = path.join(CLAUDIO_DIR, 'chat_history.json');
// How many of the most recent messages the UI loads on open (older ones load on demand).
const CHAT_HISTORY_PAGE_SIZE = 30;
const TASTE_FILE_PATH = path.join(CLAUDIO_DIR, 'TASTE.md');
const CONVERSATIONS_DB_PATH = path.join(CLAUDIO_DIR, 'conversations.db');

// Ensure directories exist
function ensureDirectories() {
  try {
    if (!fs.existsSync(CLAUDIO_DIR)) {
      fs.mkdirSync(CLAUDIO_DIR, { recursive: true });
    }
    if (!fs.existsSync(MUSIC_DIR)) {
      fs.mkdirSync(MUSIC_DIR, { recursive: true });
    }
  } catch (err) {
    console.error('Failed to create Claudio directories:', err);
  }
}
ensureDirectories();

// One-time migration: flatten the legacy <CLAUDIO_DIR>/music sub-layer up into CLAUDIO_DIR.
function migrateLegacyMusicDir() {
  try {
    const legacyDir = path.join(CLAUDIO_DIR, 'music');
    if (legacyDir === CLAUDIO_DIR || !fs.existsSync(legacyDir)) return;
    for (const name of ['user_session.json', 'liked_songs.jsonl']) {
      const from = path.join(legacyDir, name);
      const to = path.join(CLAUDIO_DIR, name);
      if (fs.existsSync(from) && !fs.existsSync(to)) {
        fs.renameSync(from, to);
        console.log(`[Migrate] moved ${name} out of legacy music/ folder`);
      }
    }
    // Remove the legacy folder if it's now empty.
    try {
      if (fs.readdirSync(legacyDir).length === 0) fs.rmdirSync(legacyDir);
    } catch {
      /* keep if not empty */
    }
  } catch (err) {
    console.error('[Migrate] legacy music dir migration failed:', err);
  }
}
migrateLegacyMusicDir();

// Ensure the data directory exists. The persona/system prompt now lives in code
// (server/musicAgent.ts → CLAUDIO_PERSONA); we no longer read or seed a CLAUDIO.md.
// NOTE: deliberately do NOT seed a default TASTE.md either. A profile must be earned from real music
// data via Module A. Seeding one makes readTasteState() infer "ready" (taste.ts) and silently
// swallows the first-login引导 prompt — TASTE.md should only exist after a genuine generation.
ensureDirectories();

// Setup configuration default state
const DEFAULT_CONFIG = {
  llm: {
    apiAddress: 'https://api.openai.com/v1',
    apiKey: '',
    modelName: 'gpt-3.5-turbo',
  },
  tts: {
    appId: '',
    apiKey: '',
    resourceId: '',
    voiceType: 'zh_male_wennuanahu_uranus_bigtts',
    // 逐曲解说（串词 / DJ patter）开关：开启后每首歌开始时生成一段口播盖在音乐上。客户端的 FM useEffect 读它。
    // 默认开启 (default ON) — 新装即有电台串词；用户可在 Settings 关闭并写回 config.json。
    narration: true,
  },
  // UI 偏好现在也住在 config.json（主题/时钟字体）。主题默认 dark。这些不参与凭证的 .env 合并，
  // 直接按 config.json 取值或回落默认。
  ui: {
    theme: 'dark' as 'dark' | 'light',
    clockFontIdx: 0,
  },
  // 私人 FM 默认模式：app 启动即进入 FM 单曲流（无限随便放）。default ON —— 新装/刷新即开电台。
  // config.json 为准；缺省时回落 .env 的 FM_DEFAULT，再回落这里的 true。客户端启动读它决定是否开 FM。
  fm: {
    default: true,
  },
};

// Build a unified TTS adapter config (豆包/Fish) from env + currentConfig (D-18/D-19).
// Doubao credentials use the DOUBAO_ env prefix (or the Settings UI / config.json).
// Fish credentials use the FISH_ env prefix, with its own proxy (FISH_PROXY).
function buildTtsConfig(): Tts.TtsConfig {
  const doubao = {
    apiKey: currentConfig.tts.apiKey || process.env.DOUBAO_TTS_API_KEY || '',
    resourceId:
      currentConfig.tts.resourceId || process.env.DOUBAO_TTS_RESOURCE_ID || 'seed-tts-2.0',
    appId: currentConfig.tts.appId || process.env.DOUBAO_TTS_APP_ID || '',
    speaker:
      currentConfig.tts.voiceType ||
      process.env.DOUBAO_TTS_SPEAKER ||
      'zh_male_wennuanahu_uranus_bigtts',
  };
  const fish = {
    apiKey: process.env.FISH_API_KEY || '',
    model: process.env.FISH_TTS_MODEL || 's2-pro',
    referenceId: process.env.FISH_TTS_REFERENCE_ID || '',
    // Fish needs a proxy from mainland China; keep it separate from any system-wide proxy.
    proxy: process.env.FISH_PROXY || process.env.HTTPS_PROXY || process.env.ALL_PROXY || '',
    // Volume gain in dB; Fish sounds quieter than Doubao, so default to +8.
    volume: process.env.FISH_VOLUME ? parseFloat(process.env.FISH_VOLUME) : 8,
    speed: process.env.FISH_SPEED ? parseFloat(process.env.FISH_SPEED) : undefined,
    temperature: process.env.FISH_TEMPERATURE
      ? parseFloat(process.env.FISH_TEMPERATURE)
      : undefined,
    topP: process.env.FISH_TOP_P ? parseFloat(process.env.FISH_TOP_P) : undefined,
  };

  // Provider selection: explicit TTS_PROVIDER wins; otherwise auto — prefer Fish when both
  // are configured, fall back to Doubao.
  const forced = (process.env.TTS_PROVIDER || '').toLowerCase();
  let provider: Tts.Provider;
  if (forced === 'fish' || forced === 'doubao') provider = forced;
  else if (fish.apiKey)
    provider = 'fish'; // 两个都配 → 优先 fish
  else provider = 'doubao';

  return {
    provider,
    doubao,
    fish,
    speechRate: -8, // gentle late-night baseline; per-sentence emotion carried by script
  };
}

// Legacy UI preferences file (theme/clock font). UI prefs now live inside config.json under `ui`;
// this is only read once to migrate an old install's preferences.json into config.ui.
function readLegacyPreferences(): { theme: 'dark' | 'light'; clockFontIdx: number } | null {
  try {
    if (fs.existsSync(PREFERENCES_FILE_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(PREFERENCES_FILE_PATH, 'utf-8'));
      return {
        theme: parsed?.theme === 'light' ? 'light' : 'dark',
        clockFontIdx: Number.isInteger(parsed?.clockFontIdx)
          ? parsed.clockFontIdx
          : DEFAULT_CONFIG.ui.clockFontIdx,
      };
    }
  } catch (err) {
    console.error('Failed to read legacy preferences.json, ignoring:', err);
  }
  return null;
}

let currentConfig = { ...DEFAULT_CONFIG };

// Parse a boolean-ish env var ("1"/"true"/"yes"/"on" → true, "0"/"false"/"no"/"off" → false).
// Returns undefined when the var is unset/blank/unrecognized, so the caller falls through to defaults.
function envBool(raw: string | undefined): boolean | undefined {
  if (raw == null) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === '') return undefined;
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return undefined;
}

// Pull env-derived credentials. These are now a FALLBACK *beneath* config.json — used to fill any
// blank field and to seed a fresh config.json on first run (no config.json → load .env → write file).
function envCredentials() {
  return {
    llm: {
      apiAddress:
        process.env.LLM_API_ADDRESS ||
        process.env.OPENAI_API_BASE ||
        process.env.OPENAI_BASE_URL ||
        '',
      apiKey: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '',
      modelName:
        process.env.LLM_MODEL_NAME || process.env.OPENAI_MODEL_NAME || process.env.LLM_MODEL || '',
    },
    // TTS (Doubao) falls back through the DOUBAO_TTS_* prefix too — that's what buildTtsConfig()
    // reads, and what the .env actually sets — so currentConfig.tts mirrors the live Doubao creds.
    tts: {
      appId:
        process.env.TTS_APP_ID ||
        process.env.VOLC_TTS_APP_ID ||
        process.env.DOUBAO_TTS_APP_ID ||
        '',
      apiKey:
        process.env.TTS_API_KEY ||
        process.env.VOLC_TTS_API_KEY ||
        process.env.DOUBAO_TTS_API_KEY ||
        '',
      resourceId:
        process.env.TTS_RESOURCE_ID ||
        process.env.VOLC_TTS_RESOURCE_ID ||
        process.env.DOUBAO_TTS_RESOURCE_ID ||
        '',
      voiceType:
        process.env.TTS_VOICE_TYPE ||
        process.env.VOLC_TTS_VOICE_TYPE ||
        process.env.DOUBAO_TTS_SPEAKER ||
        '',
    },
    // 私人 FM 默认开关。FM_DEFAULT 未设/无法识别时为 undefined → 回落到 DEFAULT_CONFIG.fm.default。
    fm: {
      default: envBool(process.env.FM_DEFAULT),
    },
  };
}

// Load Configuration with priority: config.json > .env > DEFAULT_CONFIG.
// config.json is the authoritative source; a value set there always wins. Any field left blank
// (or missing) in config.json falls back to .env, then to the built-in default. When no config.json
// exists at all, we resolve from .env + defaults and WRITE the file so it becomes authoritative.
// UI prefs (theme/clock font) and the DJ-patter (narration) switch live in config.json with no env
// layer — they take the config.json value or the default.
function loadConfig() {
  try {
    ensureDirectories();
    const env = envCredentials();

    let parsed: any = null;
    const exists = fs.existsSync(CONFIG_FILE_PATH);
    if (exists) {
      try {
        parsed = JSON.parse(fs.readFileSync(CONFIG_FILE_PATH, 'utf-8'));
      } catch (parseErr) {
        console.error('Failed to parse config.json, falling back to .env + defaults:', parseErr);
      }
    }

    // config.json value (if non-empty) > .env value (if non-empty) > built-in default.
    const pick = (fileVal: any, envVal: string, defVal: string): string => {
      if (typeof fileVal === 'string' && fileVal !== '') return fileVal;
      if (envVal) return envVal;
      return defVal;
    };

    // UI prefs: prefer config.ui; if absent, migrate a legacy preferences.json; else defaults.
    const legacyUi = parsed?.ui ? null : readLegacyPreferences();
    const uiSource = parsed?.ui ?? legacyUi ?? DEFAULT_CONFIG.ui;

    currentConfig = {
      llm: {
        apiAddress: pick(
          parsed?.llm?.apiAddress,
          env.llm.apiAddress,
          DEFAULT_CONFIG.llm.apiAddress,
        ),
        apiKey: pick(parsed?.llm?.apiKey, env.llm.apiKey, DEFAULT_CONFIG.llm.apiKey),
        modelName: pick(parsed?.llm?.modelName, env.llm.modelName, DEFAULT_CONFIG.llm.modelName),
      },
      tts: {
        appId: pick(parsed?.tts?.appId, env.tts.appId, DEFAULT_CONFIG.tts.appId),
        apiKey: pick(parsed?.tts?.apiKey, env.tts.apiKey, DEFAULT_CONFIG.tts.apiKey),
        resourceId: pick(
          parsed?.tts?.resourceId,
          env.tts.resourceId,
          DEFAULT_CONFIG.tts.resourceId,
        ),
        voiceType: pick(parsed?.tts?.voiceType, env.tts.voiceType, DEFAULT_CONFIG.tts.voiceType),
        // DJ patter (串词): config.json is authoritative; default ON when unset.
        narration:
          typeof parsed?.tts?.narration === 'boolean'
            ? parsed.tts.narration
            : DEFAULT_CONFIG.tts.narration,
      },
      ui: {
        theme: (uiSource as any)?.theme === 'light' ? 'light' : 'dark',
        clockFontIdx: Number.isInteger((uiSource as any)?.clockFontIdx)
          ? (uiSource as any).clockFontIdx
          : DEFAULT_CONFIG.ui.clockFontIdx,
      },
      fm: {
        // config.json 为准 → .env 的 FM_DEFAULT → 内置默认（true）。
        default:
          typeof parsed?.fm?.default === 'boolean'
            ? parsed.fm.default
            : env.fm.default !== undefined
              ? env.fm.default
              : DEFAULT_CONFIG.fm.default,
      },
    };

    // Persist config.json when it's missing (first run → seed from .env), or when an existing file
    // predates the `ui`/`fm` section (fold in defaults / migrated legacy prefs) so it stays authoritative.
    if (!exists || !parsed?.ui || !parsed?.fm) {
      fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(currentConfig, null, 2), 'utf-8');
    }

    console.log('[Config] Loaded. Priority: config.json > .env > DEFAULT_CONFIG');
  } catch (err) {
    console.error('Failed to load configuration, using defaults:', err);
    currentConfig = { ...DEFAULT_CONFIG };
  }
}
loadConfig();

// Load User Netease Session
let userSession: any = null;
function loadUserSession() {
  try {
    ensureDirectories();
    if (fs.existsSync(SESSION_FILE_PATH)) {
      const rawData = fs.readFileSync(SESSION_FILE_PATH, 'utf-8');
      userSession = JSON.parse(rawData);
      console.log('Loaded Netease Cloud Music user session for:', userSession?.nickname);
    } else {
      userSession = null;
    }
  } catch (e) {
    console.error('Could not read user session on startup:', e);
    userSession = null;
  }
}
loadUserSession();

// Load Persistent Chat History (JSONL — one message object per line).
let chatHistory: any[] = [];
function loadChatHistory() {
  try {
    ensureDirectories();
    // One-time migration: if only the legacy single-JSON-array file exists, fold it into JSONL.
    if (!fs.existsSync(CHAT_HISTORY_FILE_PATH) && fs.existsSync(CHAT_HISTORY_LEGACY_PATH)) {
      try {
        const legacy = JSON.parse(fs.readFileSync(CHAT_HISTORY_LEGACY_PATH, 'utf-8'));
        if (Array.isArray(legacy)) {
          fs.writeFileSync(
            CHAT_HISTORY_FILE_PATH,
            legacy.map((m) => JSON.stringify(m)).join('\n') + (legacy.length ? '\n' : ''),
            'utf-8',
          );
          console.log(`Migrated ${legacy.length} chat records from legacy JSON → JSONL`);
        }
      } catch (e) {
        console.error('Chat history migration failed:', e);
      }
    }
    if (fs.existsSync(CHAT_HISTORY_FILE_PATH)) {
      const raw = fs.readFileSync(CHAT_HISTORY_FILE_PATH, 'utf-8');
      chatHistory = raw
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      console.log(`Loaded ${chatHistory.length} chat history records from disk`);
    } else {
      chatHistory = [];
    }
  } catch (err) {
    console.error('Failed to load chat history:', err);
    chatHistory = [];
  }
}
loadChatHistory();

// Append a single message as one JSONL line (the normal per-turn write path — no whole-file rewrite).
function appendChatMessage(msg: any) {
  chatHistory.push(msg);
  try {
    ensureDirectories();
    fs.appendFileSync(CHAT_HISTORY_FILE_PATH, JSON.stringify(msg) + '\n', 'utf-8');
  } catch (err) {
    console.error('Failed to append chat message:', err);
  }
}

// LangGraph conversation thread: the checkpointer holds the model-facing context (including
// tool-call turns) per thread_id, persisted to SQLite under CLAUDIO_DIR so it survives restarts
// (SPEC §技术栈 SqliteSaver). chat_history.json remains the UI-facing source of truth.
const AGENT_THREAD_ID = 'claudio-main-broadcast';
const AGENT_THREAD_CONFIG = { configurable: { thread_id: AGENT_THREAD_ID } };
const agentCheckpointer = SqliteSaver.fromConnString(CONVERSATIONS_DB_PATH);
console.log(`[Server] agent checkpointer: SQLite @ ${CONVERSATIONS_DB_PATH}`);

// Player state mirror (单一事实源 for 双通道控制): updated by the agent and by the
// frontend (UI direct control posts the latest state so agent reads truth — D-11/B-R6).
let playerState: MusicAgent.PlayerState = {
  status: 'stopped',
  queue: [],
  currentIndex: 0,
  personalFm: false,
  narration: !!currentConfig.tts.narration,
};

// Shared structured LLM invoker used by Module A taste gen and narration gen.
async function invokeLLM(system: string, user: string): Promise<string> {
  const model = getLangchainModel();
  const res = await model.invoke([new SystemMessage(system), new HumanMessage(user)]);
  return typeof res.content === 'string' ? res.content : (res as any).text || '';
}

// Location + weather are cached and refreshed at most every 30 minutes; the per-turn context just
// reads the cache so we don't hit the geo/weather APIs on every message. (getWeather / fetchWeatherFresh
// are defined further down, after WEATHER_CODES; function declarations are hoisted so this is fine.)
interface WeatherInfo {
  city: string;
  region: string;
  country: string;
  code: number;
  desc: string;
  temp: number;
  feelsLike: number;
  humidity: number;
  wind: number;
}
const WEATHER_TTL_MS = 30 * 60 * 1000;
let weatherCache: WeatherInfo | null = null;
let weatherFetchedAt = 0;
let weatherInflight: Promise<WeatherInfo | null> | null = null;

// Dynamic per-turn context (time + location + weather) — appended to the END of the user message,
// not the system prompt. Time includes the weekday, full date and AM/PM; location/weather come from
// the 30-minute cache (a stale cache triggers a non-blocking background refresh).
function cityTimeWeather(): string {
  if (Date.now() - weatherFetchedAt > WEATHER_TTL_MS) void getWeather();
  const now = new Date();
  const time = now.toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const w = weatherCache;
  if (!w) return `time: ${time}`;
  const place = [w.city, w.region].filter(Boolean).join(', ') || w.country;
  return `time: ${time} | location: ${place} | weather: ${w.desc}, ${Math.round(w.temp)}°C (feels ${Math.round(w.feelsLike)}°C)`;
}

app.use(express.json());

// Default playlist: a single Netease track ("All Too Well", Taylor's Version), streamed
// through the backend proxy. Replaces the old curated demo tracks.
const TRACKS_PLAYLIST = [
  {
    id: 'netease-1891454317',
    title: "All Too Well (Taylor's Version)",
    artist: 'Taylor Swift',
    album: "Red (Taylor's Version)",
    duration: 329, // 5:29
    url: '/api/stream?id=1891454317',
    story: '',
  },
];

// Default playlist for the client:
//  - logged in  → ALL of the user's liked (红心) songs (no extra default track appended)
//  - logged out → Netease recommendations playable WITHOUT login (personalized_newsong);
//                 falls back to the curated TRACKS_PLAYLIST only if recommendations fail.
app.get('/api/tracks', async (req, res) => {
  if (userSession && userSession.tracks && userSession.tracks.length > 0) {
    return res.json(userSession.tracks);
  }
  try {
    const recs = await getDefaultRecommendations(userSession?.cookie);
    if (recs.length > 0) {
      return res.json(
        recs.map((s) => ({
          id: `netease-${s.id}`,
          title: s.name,
          artist: s.artist,
          album: s.album,
          duration: s.duration,
          url: `/api/stream?id=${s.id}`,
          story: '',
        })),
      );
    }
  } catch (err: any) {
    log.warn('/api/tracks recommendations failed, using fallback', { error: err.message });
  }
  res.json(TRACKS_PLAYLIST);
});

// Audio stream proxy: resolve a FRESH netease play URL per request and stream the bytes
// through the server (China-direct), so playback bypasses the browser's proxy/geo 403 and
// never hits the original link's expiry. Forwards Range so seeking/progressive buffering works.
app.get('/api/stream', async (req, res) => {
  const id = ((req.query.id as string) || '').replace(/^netease-/, '');
  if (!id) return res.status(400).json({ error: 'id is required' });
  try {
    const url = await resolvePlayUrl(id, userSession?.cookie);
    const range = req.headers.range;
    const upstreamHeaders: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      Referer: 'https://music.163.com/',
    };
    if (range) upstreamHeaders['Range'] = range;

    const upstream = await fetch(url, { headers: upstreamHeaders });
    if (!upstream.ok && upstream.status !== 206) {
      log.warn(`/api/stream upstream ${upstream.status} for song ${id}`, { url });
      return res
        .status(upstream.status === 404 ? 404 : 502)
        .json({ error: `Upstream ${upstream.status}` });
    }

    res.status(upstream.status);
    // NOTE: do NOT forward upstream cache-control/etag/last-modified. Our URL (/api/stream?id=X) is
    // stable but the underlying CDN url is re-resolved every request — caching it lets a stale clip
    // (e.g. a 30s trial served before login/quality was sorted) stick under the same id forever, so
    // server-side fixes never take effect. Force no-store so each play re-resolves a fresh url.
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.setHeader('Cache-Control', 'no-store');
    if (!upstream.headers.get('accept-ranges')) res.setHeader('Accept-Ranges', 'bytes');
    if (!upstream.headers.get('content-type')) res.setHeader('Content-Type', 'audio/mpeg');

    if (!upstream.body) return res.end();
    const nodeStream = Readable.fromWeb(upstream.body as any);
    res.on('close', () => nodeStream.destroy());
    nodeStream.on('error', () => {
      if (!res.writableEnded) res.end();
    });
    nodeStream.pipe(res);
  } catch (err: any) {
    log.error(`/api/stream failed for ${id}`, { error: err.message });
    if (!res.headersSent) res.status(502).json({ error: err.message });
  }
});

// User Session Endpoint
app.get('/api/user/session', (req, res) => {
  res.json(userSession || { isLoggedIn: false });
});

// Logout Endpoint
app.post('/api/user/logout', (req, res) => {
  userSession = null;
  try {
    if (fs.existsSync(SESSION_FILE_PATH)) {
      fs.unlinkSync(SESSION_FILE_PATH);
    }
  } catch (e) {
    console.error('Error deleting session file:', e);
  }
  res.json({ success: true });
});

// Build (and persist) the user session from a raw cookie. Shared by QR login and the
// "official web login → paste cookie" path. Cookie must contain at least MUSIC_U.
async function buildUserSessionFromCookie(rawCookie: string) {
  const api = (neteaseApi as any).default || neteaseApi;
  const cookie = (rawCookie || '').trim();
  if (!cookie) throw new Error('Cookie 为空');

  const accountResult = await api.user_account({ cookie });
  const profile = accountResult.body?.profile;
  if (!profile)
    throw new Error('Cookie 无效或已过期：拿不到账号信息（确认粘贴的内容包含 MUSIC_U=...）');

  const nickname = profile.nickname;
  const avatarUrl = profile.avatarUrl;
  const userId = profile.userId || accountResult.body.account?.id;

  // Liked/heart playlist (the user's FIRST playlist = "我喜欢的音乐") — load ALL its tracks.
  let mappedTracks: any[] = [];
  try {
    const playlistResult = await api.user_playlist({ uid: userId, cookie });
    const playlists = playlistResult.body?.playlist || [];
    if (playlists.length > 0) {
      const liked = playlists[0];
      const total = liked.trackCount || 1000;
      const tracksResult = await api.playlist_track_all({ id: liked.id, limit: total, cookie });
      const songs = tracksResult.body?.songs || [];
      mappedTracks = songs.map((song: any) => ({
        id: `netease-${song.id}`,
        title: song.name,
        artist: song.ar?.map((a: any) => a.name).join(', ') || 'Unknown Artist',
        album: song.al?.name || 'Unknown Album',
        duration: Math.round((song.dt || 180000) / 1000),
        url: `/api/stream?id=${song.id}`,
        story: `Your Netease Cloud Music Liked track, from album "${song.al?.name || ''}". Broadcasted live.`,
      }));
    }
  } catch (e: any) {
    console.warn('[Login] playlist preview fetch failed (login still valid):', e.message);
  }

  ensureDirectories();
  userSession = { isLoggedIn: true, userId, nickname, avatarUrl, tracks: mappedTracks, cookie };
  fs.writeFileSync(SESSION_FILE_PATH, JSON.stringify(userSession, null, 2), 'utf-8');
  console.log('Session saved successfully for Netease user:', nickname);
  return userSession;
}

// Cookie login: paste the cookie obtained after logging in on the official web page.
app.post('/api/login/cookie', async (req, res) => {
  try {
    const { cookie } = req.body || {};
    if (!cookie || !cookie.trim()) {
      return res
        .status(400)
        .json({ error: '请粘贴登录 music.163.com 后提取的 cookie（至少包含 MUSIC_U=...）' });
    }
    const session = await buildUserSessionFromCookie(cookie);
    res.json({
      success: true,
      isLoggedIn: true,
      userId: session.userId,
      nickname: session.nickname,
      avatarUrl: session.avatarUrl,
    });
  } catch (err: any) {
    console.error('Cookie login failed:', err);
    res.status(401).json({ error: err.message });
  }
});

// Netease QR Code Key Endpoint
app.get('/api/login/qr/key', async (req, res) => {
  try {
    const api = (neteaseApi as any).default || neteaseApi;
    const result = await api.login_qr_key({});
    res.json({ key: result.body.data.unikey });
  } catch (error: any) {
    console.error('Fetch unikey error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Netease QR Code Create Endpoint
app.get('/api/login/qr/create', async (req, res) => {
  try {
    const { key } = req.query;
    if (!key) return res.status(400).json({ error: 'key is required' });
    const api = (neteaseApi as any).default || neteaseApi;
    const result = await api.login_qr_create({ key, qrimg: true });
    res.json({
      qrurl: result.body.data.qrurl,
      qrimg: result.body.data.qrimg,
    });
  } catch (error: any) {
    console.error('QR Code create error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Netease QR Code Status Check Endpoint
app.get('/api/login/qr/check', async (req, res) => {
  try {
    const { key } = req.query;
    if (!key) return res.status(400).json({ error: 'key is required' });
    const api = (neteaseApi as any).default || neteaseApi;
    const checkResult = await api.login_qr_check({ key });
    const code = checkResult.body.code;

    if (code === 803) {
      // Success! Retrieve cookie and build the session (shared with cookie login).
      const cookie = checkResult.body.cookie;
      if (!cookie) throw new Error('No cookie returned on successful authentication');
      await buildUserSessionFromCookie(cookie);
    }

    res.json({ code, message: checkResult.body.message || '' });
  } catch (error: any) {
    console.error('QR Code status check error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Log level — query / change at runtime (configurable on demand).
app.get('/api/loglevel', (req, res) => res.json({ level: getLogLevel() }));
app.post('/api/loglevel', (req, res) => {
  const level = setLogLevel((req.body?.level || '').toString());
  log.info(`log level set to ${level}`);
  res.json({ level });
});

// IP geolocation + current weather (server-side proxy so the HTTP-only ip-api.com call
// doesn't trip mixed-content blocking from an HTTPS page). Mirrors weather.py.
// WMO 4677 weather codes → Chinese descriptions (Open-Meteo returns these 28).
const WEATHER_CODES: Record<number, string> = {
  0: '晴',
  1: '大致晴朗',
  2: '局部多云',
  3: '阴',
  45: '雾',
  48: '雾凇',
  51: '毛毛雨(小)',
  53: '毛毛雨(中)',
  55: '毛毛雨(大)',
  56: '冻毛毛雨(小)',
  57: '冻毛毛雨(大)',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨(小)',
  67: '冻雨(大)',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '雪粒',
  80: '阵雨(小)',
  81: '阵雨(中)',
  82: '阵雨(大)',
  85: '阵雪(小)',
  86: '阵雪(大)',
  95: '雷阵雨',
  96: '雷阵雨伴小冰雹',
  99: '雷阵雨伴大冰雹',
};

// One real fetch: IP geolocation (ip-api) → current weather (open-meteo). Throws on failure.
async function fetchWeatherFresh(): Promise<WeatherInfo> {
  const locResp = await fetch('http://ip-api.com/json/', { signal: AbortSignal.timeout(10000) });
  const loc: any = await locResp.json();
  if (loc?.status !== 'success') throw new Error('IP geolocation failed');

  const params = new URLSearchParams({
    latitude: String(loc.lat),
    longitude: String(loc.lon),
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m',
    timezone: 'auto',
  });
  const wResp = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, {
    signal: AbortSignal.timeout(10000),
  });
  const w: any = await wResp.json();
  const cur = w?.current;
  if (!cur) throw new Error('weather fetch failed');

  return {
    city: loc.city,
    region: loc.regionName,
    country: loc.country,
    code: cur.weather_code,
    desc: WEATHER_CODES[cur.weather_code] ?? '未知',
    temp: cur.temperature_2m,
    feelsLike: cur.apparent_temperature,
    humidity: cur.relative_humidity_2m,
    wind: cur.wind_speed_10m,
  };
}

// Cached accessor: returns weather if it's < 30 min old; otherwise fetches once (concurrent callers
// share the same in-flight promise). On failure, keeps serving the last good cache.
async function getWeather(force = false): Promise<WeatherInfo | null> {
  const fresh = Date.now() - weatherFetchedAt < WEATHER_TTL_MS;
  if (weatherCache && fresh && !force) return weatherCache;
  if (weatherInflight) return weatherInflight;
  weatherInflight = (async () => {
    try {
      const w = await fetchWeatherFresh();
      weatherCache = w;
      weatherFetchedAt = Date.now();
      return weatherCache;
    } catch (err: any) {
      log.warn('weather refresh failed', { error: err.message });
      return weatherCache;
    } finally {
      weatherInflight = null;
    }
  })();
  return weatherInflight;
}
// Warm the cache at startup so the first turn already has location/weather.
void getWeather();

app.get('/api/weather', async (req, res) => {
  const w = await getWeather();
  if (!w) return res.status(502).json({ error: 'weather unavailable' });
  res.json(w);
});

// Fetch configuration
app.get('/api/config', (req, res) => {
  res.json(currentConfig);
});

// Update configuration
app.post('/api/config', (req, res) => {
  try {
    const { llm, tts, ui, fm } = req.body;
    // Start from the on-disk file (NOT the env-merged currentConfig) so a save never bakes a
    // .env fallback value into config.json — blanks stay blank and keep falling back to .env.
    let savedConfig: typeof DEFAULT_CONFIG = {
      llm: { ...DEFAULT_CONFIG.llm },
      tts: { ...DEFAULT_CONFIG.tts },
      ui: { ...DEFAULT_CONFIG.ui },
      fm: { ...DEFAULT_CONFIG.fm },
    };

    if (fs.existsSync(CONFIG_FILE_PATH)) {
      try {
        const raw = fs.readFileSync(CONFIG_FILE_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        savedConfig = {
          llm: {
            apiAddress: parsed?.llm?.apiAddress || DEFAULT_CONFIG.llm.apiAddress,
            apiKey: parsed?.llm?.apiKey || DEFAULT_CONFIG.llm.apiKey,
            modelName: parsed?.llm?.modelName || DEFAULT_CONFIG.llm.modelName,
          },
          tts: {
            appId: parsed?.tts?.appId || DEFAULT_CONFIG.tts.appId,
            apiKey: parsed?.tts?.apiKey || DEFAULT_CONFIG.tts.apiKey,
            resourceId: parsed?.tts?.resourceId || DEFAULT_CONFIG.tts.resourceId,
            voiceType: parsed?.tts?.voiceType || DEFAULT_CONFIG.tts.voiceType,
            narration: parsed?.tts?.narration ?? DEFAULT_CONFIG.tts.narration,
          },
          ui: {
            theme: parsed?.ui?.theme === 'light' ? 'light' : 'dark',
            clockFontIdx: Number.isInteger(parsed?.ui?.clockFontIdx)
              ? parsed.ui.clockFontIdx
              : DEFAULT_CONFIG.ui.clockFontIdx,
          },
          fm: {
            default:
              typeof parsed?.fm?.default === 'boolean'
                ? parsed.fm.default
                : DEFAULT_CONFIG.fm.default,
          },
        };
      } catch (parseErr) {
        console.error('Failed to parse disk config before save merge, using defaults:', parseErr);
      }
    }

    // Apply client updates
    if (llm) savedConfig.llm = { ...savedConfig.llm, ...llm };
    if (tts) savedConfig.tts = { ...savedConfig.tts, ...tts };
    if (ui) savedConfig.ui = { ...savedConfig.ui, ...ui };
    if (fm) savedConfig.fm = { ...savedConfig.fm, ...fm };

    ensureDirectories();
    fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(savedConfig, null, 2), 'utf-8');

    // Reload resolved config in memory with the config.json > .env > default priority applied
    loadConfig();

    res.json({ success: true, config: currentConfig });
  } catch (err: any) {
    res.status(500).json({ error: `Failed to save configuration: ${err.message}` });
  }
});

// UI preferences (theme, clock font) now live in config.json under `ui`. These endpoints keep the
// same {theme, clockFontIdx} contract the client already speaks, backed by config.ui.
app.get('/api/preferences', (req, res) => {
  res.json(currentConfig.ui);
});

// Persist UI preferences into config.ui. Merges onto the current copy so a partial update (e.g.
// just the theme) doesn't drop the other field.
app.post('/api/preferences', (req, res) => {
  try {
    const { theme, clockFontIdx } = req.body || {};
    const next = {
      theme: theme === 'light' || theme === 'dark' ? theme : currentConfig.ui.theme,
      clockFontIdx: Number.isInteger(clockFontIdx) ? clockFontIdx : currentConfig.ui.clockFontIdx,
    };
    // Write through /api/config's persistence path so the whole config.json (incl. ui) is rewritten
    // atomically and currentConfig is reloaded.
    let savedConfig: typeof DEFAULT_CONFIG = {
      llm: { ...currentConfig.llm },
      tts: { ...currentConfig.tts },
      ui: next,
      fm: { ...currentConfig.fm },
    };
    if (fs.existsSync(CONFIG_FILE_PATH)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE_PATH, 'utf-8'));
        // Preserve on-disk credentials verbatim (don't bake env fallbacks into the file).
        savedConfig.llm = { ...DEFAULT_CONFIG.llm, ...(parsed?.llm || {}) };
        savedConfig.tts = { ...DEFAULT_CONFIG.tts, ...(parsed?.tts || {}) };
        savedConfig.fm = { ...DEFAULT_CONFIG.fm, ...(parsed?.fm || {}) };
      } catch {
        /* keep currentConfig credentials as a fallback */
      }
    }
    ensureDirectories();
    fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(savedConfig, null, 2), 'utf-8');
    loadConfig();
    res.json({ success: true, preferences: currentConfig.ui });
  } catch (err: any) {
    res.status(500).json({ error: `Failed to save preferences: ${err.message}` });
  }
});

// qwen (DashScope's OpenAI-compatible API) omits `role` in the FIRST streamed delta when the reply
// is a tool call — real OpenAI always sends `role:"assistant"` there. @langchain/openai then maps the
// role-less chunk to a generic ChatMessageChunk (dropping tool_calls), which poisons the whole
// streamed aggregation: tool calls vanish and langchain's strict wrapModelCall validator throws. A
// streamed chat-completion response is ALWAYS the assistant, so defaulting a missing delta role to
// "assistant" is safe and restores tool calls. We patch the converter on the completions class
// PROTOTYPE (not the instance): createAgent clones the model, so an instance patch is lost on the
// clone, but every clone shares the prototype. Idempotent + fully guarded so a future
// @langchain/openai that fixes this upstream — or renames internals — never breaks model creation.
const QWEN_ROLE_PATCH = Symbol.for('claudio.qwenDeltaRolePatched');
function patchDeltaRoleDefault(model: any) {
  try {
    const proto = Object.getPrototypeOf(model?.completions ?? {});
    const orig = proto?._convertCompletionsDeltaToBaseMessageChunk;
    if (typeof orig !== 'function' || proto[QWEN_ROLE_PATCH]) return;
    proto._convertCompletionsDeltaToBaseMessageChunk = function (
      delta: any,
      raw: any,
      defaultRole?: any,
    ) {
      return orig.call(this, delta, raw, defaultRole ?? 'assistant');
    };
    proto[QWEN_ROLE_PATCH] = true;
    console.log(
      '[LangChain] patched OpenAI delta-role default → assistant (qwen tool-call streaming fix)',
    );
  } catch {
    /* best-effort hardening; never block model creation */
  }
}

// Helper to get LangChain model based on active config or server-side Gemini
function getLangchainModel() {
  if (currentConfig.llm.apiKey) {
    console.log(`[LangChain] Instantiating ChatOpenAI model: ${currentConfig.llm.modelName}`);
    const model = new ChatOpenAI({
      apiKey: currentConfig.llm.apiKey,
      configuration: {
        baseURL: currentConfig.llm.apiAddress,
      },
      model: currentConfig.llm.modelName,
      temperature: 0.85,
    });
    patchDeltaRoleDefault(model);
    return model;
  } else {
    throw new Error(
      'No LLM is configured. Set LLM_API_KEY (and LLM_API_ADDRESS / LLM_MODEL_NAME) or configure the LLM in config.json.',
    );
  }
}

// Poetic Offline Rule-based Music Taste Generator as absolute fallback
function generateLocalTasteProfileOffline(artistCounts: [string, number][]): string {
  const top = artistCounts.slice(0, 20);
  const totalSongs = artistCounts.reduce((s, [, c]) => s + c, 0);
  const topNames = top.map(([n]) => n).join('、');
  const dominantCount = top[0]?.[1] || 0;

  // 简单启发式：中文艺人 vs 英文艺人占比 → 推断语种偏好
  const cnRe = /[一-鿿]/;
  const cnSongs = artistCounts.filter(([n]) => cnRe.test(n)).reduce((s, [, c]) => s + c, 0);
  const cnRatio = totalSongs > 0 ? cnSongs / totalSongs : 0;

  let langTag = '华语为主';
  if (cnRatio < 0.3) langTag = '英语为主';
  else if (cnRatio < 0.6) langTag = '华语、英语并重';

  // 集中度：top1 占比越高 → 偏好越聚焦
  const focusDesc =
    dominantCount >= 5
      ? `{P} 的听歌习惯有明显的核心圈——前几位艺人反复出现，偏好相当集中。`
      : `{P} 的听歌口味比较分散，没有哪位艺人占据绝对主导，更像是广泛探索型。`;

  const profile = `${focusDesc}${top.length > 0 ? `红心歌单里最常出现的是${topNames}等艺人。` : ''}从数据分布看，${langTag}，${totalSongs} 首红心曲目覆盖了 ${artistCounts.length} 位不同艺人。由于缺少 LLM 分析，{P} 的品味画像仅基于简单的统计规则，等 LLM 配置好之后会生成更细致的画像。`;

  const tags = `微流派: 暂无（需 LLM 分析）
情绪: 暂无（需 LLM 分析）
声音质地: 暂无（需 LLM 分析）
人声特质: 暂无（需 LLM 分析）
年代: 暂无（需 LLM 分析）
地域/语种: ${langTag}
收听场景: 暂无（需 LLM 分析）`;

  return `<observations>
离线兜底模式：无 LLM 可用，仅根据艺人权重表做简单统计。
- 红心歌曲总数：${totalSongs}，去重艺人数：${artistCounts.length}
- top 20 艺人：${topNames || '（无数据）'}
- 中文艺人歌曲占比：${Math.round(cnRatio * 100)}%
</observations>

<profile>${profile}</profile>

<tags>${tags}</tags>`;
}

// Fetch active music taste MD profile (TASTE.md)
app.get('/api/taste', (req, res) => {
  try {
    ensureDirectories();
    if (fs.existsSync(TASTE_FILE_PATH)) {
      // User-facing view: render {P} as "你" (照镜子 — second person).
      const content = Taste.renderTaste(fs.readFileSync(TASTE_FILE_PATH, 'utf-8'), '你');
      res.json({ taste: content });
    } else {
      res.json({ taste: '' });
    }
  } catch (err: any) {
    res.status(500).json({ error: `Failed to read TASTE.md: ${err.message}` });
  }
});

// Update music taste MD profile (TASTE.md)
app.post('/api/taste', (req, res) => {
  try {
    const { taste } = req.body;
    ensureDirectories();
    fs.writeFileSync(TASTE_FILE_PATH, taste || '', 'utf-8');
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: `Failed to write TASTE.md: ${err.message}` });
  }
});

// Module A state query (taste.state.json status machine).
app.get('/api/taste/state', (req, res) => {
  res.json(Taste.readTasteState(CLAUDIO_DIR));
});

// Mark profile prompt as skipped (首登引导"跳过"出口, D-02).
app.post('/api/taste/skip', (req, res) => {
  res.json(Taste.writeTasteState(CLAUDIO_DIR, { status: 'skipped' }));
});

// Generate品味档案 via Module A pipeline (richer sourcing + state machine + atomic write).
app.post('/api/taste/generate', async (req, res) => {
  try {
    if (!userSession || !userSession.isLoggedIn || !userSession.userId) {
      return res.status(400).json({
        error:
          'Please log in with Netease Cloud Music account first so Claudio can analyze your music data.',
      });
    }

    if (!currentConfig.llm.apiKey) {
      return res.status(400).json({
        error:
          '请先配置 LLM 后再试。在 .env 中设置 LLM_API_KEY（以及可选的 LLM_API_ADDRESS / LLM_MODEL_NAME），或在设置页面中配置 LLM。',
        classification: 'no-llm',
      });
    }

    console.log('[Module A] Generating taste profile via pipeline...');
    const { taste } = await Taste.generateTasteProfile({
      claudioDir: CLAUDIO_DIR,
      musicDir: MUSIC_DIR,
      userId: userSession.userId,
      cookie: userSession.cookie,
      invokeLLM,
      offlineFallback: (data) => generateLocalTasteProfileOffline(data.artistCounts || []),
      onProgress: (stage) => console.log(`[Module A] profile_progress: ${stage}`),
    });

    res.json({ success: true, taste: Taste.renderTaste(taste, '你') });
  } catch (err: any) {
    console.error('[Module A] generation failed:', err);
    const reason = err.classification || 'service';
    res.status(500).json({ error: `Could not generate music taste (${reason}): ${err.message}` });
  }
});

// Per-song narration, generated at PLAY time (separate from queue building). The client calls
// this when a track starts, then sends the returned `script` to /api/tts for overlay playback.
app.post('/api/narration', async (req, res) => {
  try {
    const { song, userMsg, position, total } = req.body || {};
    if (!song || !song.id || !song.title) {
      return res.status(400).json({ error: 'song {id, title, artist} is required' });
    }
    const provider = buildTtsConfig().provider;

    // Pull the song's genre/mood tags + lyrics so the narration grounds in the ACTUAL track instead of
    // the AI guessing from title/artist (which forced the "不认识就别编" rule). Both best-effort, parallel.
    const numericId = String(song.id).replace(/^netease-/, '');
    const [tags, lyrics] = await Promise.all([
      getSongTags(numericId, userSession?.cookie),
      getLyric(numericId, userSession?.cookie).catch(() => ''),
    ]);

    // 时间/天气/位置只在【整点】放歌时下发（去掉秒正好 XX:00，即 minutes===0），像电台整点报时；
    // 其余时刻一律不给，串词就专注歌本身，不每首硬塞场景信息。
    const onTheHour = new Date().getMinutes() === 0;
    log.info(`/api/narration ◀ generate for`, {
      id: song.id,
      title: song.title,
      artist: song.artist,
      tags,
      lyricChars: lyrics.length,
      position,
      total,
      onTheHour,
    });
    const [item] = await MusicAgent.generateSongNarration({
      songs: [
        {
          id: song.id,
          title: song.title,
          artist: song.artist,
          album: song.album,
          year: song.year,
          reason: song.reason,
          tags,
          lyrics,
        },
      ],
      userMsg: userMsg || '',
      provider,
      invokeLLM,
      cityTimeWeather: onTheHour ? cityTimeWeather() : '',
      position:
        typeof position === 'number' && typeof total === 'number'
          ? { index: position, total }
          : undefined,
    });
    res.json({
      songId: item.songId,
      script: item.script,
      text: MusicAgent.scriptToText(item.script),
    });
  } catch (err: any) {
    log.error('/api/narration failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Persist a client-side feed line (e.g. a 串词, shown as a Claudio message) into chat history so it
// reloads next open. Display-only: it does NOT touch the LangGraph model context, just the on-disk feed.
app.post('/api/chat/log', (req, res) => {
  const m = req.body || {};
  if (!m || typeof m.text !== 'string' || !m.text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }
  appendChatMessage({
    id: typeof m.id === 'string' && m.id ? m.id : Date.now().toString(),
    sender: m.sender === 'claudio' ? 'claudio' : 'system',
    text: m.text,
    timestamp: typeof m.timestamp === 'string' ? m.timestamp : new Date().toISOString(),
    ...(typeof m.avatarUrl === 'string' ? { avatarUrl: m.avatarUrl } : {}),
  });
  res.json({ success: true });
});

// Fetch chat history — paginated, newest-last. By default returns only the latest page so the UI
// loads fast; pass ?before=<messageId> to fetch the page of older messages that precede it.
//   → { messages: [...oldest→newest...], hasMore: boolean }
app.get('/api/chat/history', (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || CHAT_HISTORY_PAGE_SIZE));
  const before = typeof req.query.before === 'string' ? req.query.before : undefined;
  let end = chatHistory.length;
  if (before) {
    const idx = chatHistory.findIndex((m) => m && m.id === before);
    if (idx >= 0) end = idx; // everything strictly before the cursor message
  }
  const start = Math.max(0, end - limit);
  res.json({ messages: chatHistory.slice(start, end), hasMore: start > 0 });
});

// Reset entire chat history
app.post('/api/chat/clear', async (req, res) => {
  chatHistory = [];
  // Wipe the LangGraph thread's persisted checkpoints so the model's memory clears too.
  try {
    await agentCheckpointer.deleteThread(AGENT_THREAD_ID);
  } catch (err) {
    console.error('Failed to delete agent thread checkpoints:', err);
  }
  try {
    ensureDirectories();
    for (const p of [CHAT_HISTORY_FILE_PATH, CHAT_HISTORY_LEGACY_PATH]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  } catch (err) {
    console.error('Failed to delete chat history file:', err);
  }
  res.json({ success: true });
});

// TTS endpoint — dual provider (豆包/Fish) via host adapter (D-18/D-19).
// GET  /api/tts?text=...            → plain text (replay button / fallback)
// POST /api/tts {script} | {text}   → structured per-sentence narration (overlay playback)
async function handleTts(res: express.Response, segments: Tts.Segment[]) {
  try {
    const cfg = buildTtsConfig();
    if (!Tts.isConfigured(cfg)) {
      return res.status(400).json({
        error: `TTS not configured for provider "${cfg.provider}". Populate credentials in Settings or .env.`,
      });
    }
    const audio = await Tts.synthesize(segments, cfg);
    if (!audio || audio.length === 0) {
      return res
        .status(500)
        .json({ error: 'Synthesized audio is empty. Verify your TTS credentials.' });
    }
    console.log(`[TTS:${cfg.provider}] synthesized ${(audio.length / 1024).toFixed(1)} KB`);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(audio);
  } catch (err: any) {
    console.error('TTS Endpoint exception:', err);
    res.status(500).json({ error: err.message });
  }
}

app.get('/api/tts', async (req, res) => {
  const text = req.query.text as string;
  if (!text) return res.status(400).json({ error: 'Text query parameter is required' });
  await handleTts(res, Tts.textToSegments(text));
});

app.post('/api/tts', async (req, res) => {
  const { script, text } = req.body || {};
  let segments: Tts.Segment[];
  if (Array.isArray(script)) {
    segments = script.map((s: any) =>
      typeof s === 'string' ? { text: s } : { text: s.text, instruction: s.instruction ?? null },
    );
  } else if (typeof text === 'string') {
    segments = Tts.textToSegments(text);
  } else {
    return res.status(400).json({ error: "Provide 'script' (array) or 'text' (string)." });
  }
  await handleTts(res, segments);
});

// Resolve an authorized playback URL using the logged-in user's cookie (supports VIP tracks).
// Falls back to the anonymous outer link when resolution fails or returns nothing.
async function resolveNeteasePlayUrl(songId: number | string): Promise<string> {
  const outerUrl = `https://music.163.com/song/media/outer/url?id=${songId}.mp3`;
  try {
    const api = (neteaseApi as any).default || neteaseApi;
    const result = await api.song_url_v1({
      id: songId,
      level: 'exhigh',
      cookie: userSession?.cookie,
    });
    const url = result.body?.data?.[0]?.url;
    if (url) {
      console.log(`[Netease] Resolved authorized play URL for song ${songId}`);
      return url;
    }
    console.warn(
      `[Netease] No playable URL for song ${songId} (VIP-only or no copyright?), falling back to outer link`,
    );
  } catch (err: any) {
    console.warn(
      `[Netease] song_url_v1 failed for song ${songId}, falling back to outer link:`,
      err.message,
    );
  }
  return outerUrl;
}

// 红心状态查询：播放器拿当前歌问「是不是红心歌」。未登录直接 liked:false。
app.get('/api/song/liked', async (req, res) => {
  try {
    const id = req.query.id as string;
    if (!id) return res.status(400).json({ error: 'missing id' });
    if (!userSession?.isLoggedIn || !userSession.userId) return res.json({ liked: false });
    const liked = await isSongLiked(id, userSession.userId, userSession.cookie);
    res.json({ liked });
  } catch (err: any) {
    log.warn('/api/song/liked failed', { error: err.message });
    res.json({ liked: false });
  }
});

// 标记/取消红心：body { id, like }。掉网易云 like 接口，成功后返回最终状态。
app.post('/api/song/like', async (req, res) => {
  try {
    const { id, like } = req.body || {};
    if (!id) return res.status(400).json({ error: 'missing id' });
    if (!userSession?.isLoggedIn || !userSession.cookie) {
      return res.status(401).json({ error: '请先登录网易云账号' });
    }
    const liked = await setSongLike(id, like !== false, userSession.cookie, userSession.userId);
    res.json({ success: true, liked });
  } catch (err: any) {
    log.error('/api/song/like failed', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

// Player state mirror endpoints (双通道控制单一事实源, D-11/B-R6).
app.get('/api/player/state', (req, res) => {
  res.json(playerState);
});
app.post('/api/player/state', (req, res) => {
  const { status, currentIndex, queue, personalFm, narration } = req.body || {};
  if (status === 'playing' || status === 'paused' || status === 'stopped')
    playerState.status = status;
  if (typeof currentIndex === 'number') playerState.currentIndex = currentIndex;
  if (Array.isArray(queue)) playerState.queue = queue;
  // 客户端把私人 FM 开关也镜像过来（含用户手动点按钮关掉的情况），这样 agent 的 get_player_state 读得到真值。
  if (typeof personalFm === 'boolean') playerState.personalFm = personalFm;
  // 串词（逐曲解说）开关同理：用户可能在设置里手动开关过，镜像过来让 agent 读到真值。
  if (typeof narration === 'boolean') playerState.narration = narration;
  res.json(playerState);
});

// 私人 FM 单曲流：客户端开启 FM 后每首播完拉【一首】下一曲。netease 的 personal_fm 一次返回数首，
// 服务端缓冲剩下的，逐首吐给客户端，避免每首都打一次接口、浪费流里的歌。
let personalFmBuffer: Track[] = [];
app.get('/api/personal-fm/next', async (_req, res) => {
  try {
    if (personalFmBuffer.length === 0) {
      const songs = await getPersonalFm(userSession?.cookie);
      personalFmBuffer = songs.map((s) => toTrack(s, 'taste'));
    }
    const track = personalFmBuffer.shift();
    if (!track)
      return res.status(503).json({ error: 'personal FM 暂时拿不到歌（可能未登录或风控）。' });
    res.json({ track });
  } catch (err: any) {
    log.error('/api/personal-fm/next failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Apply the agent's queue/player ops onto the server-side mirror.
function applySessionToPlayer(session: MusicAgent.RadioSession) {
  switch (session.queueOp) {
    case 'set':
      playerState.queue = session.queue;
      playerState.currentIndex = 0;
      break;
    case 'add': {
      // New songs go to the FRONT of what's up next: insert right after the current track so
      // they play next without interrupting the song currently on air.
      const insertAt = playerState.queue.length ? playerState.currentIndex + 1 : 0;
      playerState.queue = [
        ...playerState.queue.slice(0, insertAt),
        ...session.queue,
        ...playerState.queue.slice(insertAt),
      ];
      break;
    }
    case 'remove':
      playerState.queue = playerState.queue.filter((t) => !session.removedIds.includes(t.id));
      break;
    case 'clear':
      playerState.queue = [];
      playerState.currentIndex = 0;
      break;
  }
  if (session.autoplay) playerState.status = 'playing';
  switch (session.playerOp) {
    case 'play':
    case 'resume':
      playerState.status = 'playing';
      break;
    case 'pause':
      playerState.status = 'paused';
      break;
    case 'stop':
      playerState.status = 'stopped';
      break;
    case 'skip':
      if (playerState.queue.length > 0)
        playerState.currentIndex = (playerState.currentIndex + 1) % playerState.queue.length;
      break;
  }
  // Fine-grained controls: only play_index changes the server-side mirror; seek/volume/fmMode are
  // client-only display state that rides each tool's on_tool_end output straight to the browser.
  if (session.playIndex !== null && playerState.queue.length > 0) {
    playerState.currentIndex = Math.min(session.playIndex, playerState.queue.length - 1);
    playerState.status = 'playing';
  }
  // personal_fm({action}) tool flips this; mirror onto the server state. Committing a real queue —
  // whether replacing it (set) or queueing songs up next (add) — leaves the single-track FM stream,
  // matching the client's behaviour (set/add both setPersonalFm(false)). Otherwise FM's next fetch
  // would wipe the just-added songs.
  if (session.personalFm !== null) playerState.personalFm = session.personalFm;
  if (session.queueOp === 'set' || session.queueOp === 'add') playerState.personalFm = false;
  // narration_mode 翻转串词开关 → 镜像到 playerState，让后续 get_player_state 读到真值。
  if (session.fmMode !== null) playerState.narration = session.fmMode;
}

// Module B: DJ Agent chat turn (tool-calling loop, three-source selection, backend narration).
app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message content is required' });
    log.info(`/api/chat ◀ user message`, { message, user: userSession?.nickname || '(guest)' });

    const timestampStr = new Date().toLocaleTimeString('zh-CN', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    });
    let userAvatar =
      'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&q=80&w=120';
    if (userSession && userSession.isLoggedIn && userSession.avatarUrl)
      userAvatar = userSession.avatarUrl;

    const userMsg = {
      id: Math.random().toString(),
      sender: 'user',
      text: message,
      timestamp: timestampStr,
      avatarUrl: userAvatar,
    };
    appendChatMessage(userMsg);

    // Persona/system prompt now lives in code (musicAgent.ts). Only taste (TASTE.md) is read here.
    const tasteState = Taste.readTasteState(CLAUDIO_DIR);
    // Agents see the profile with {P} rendered as "ta" (third-person, 选歌/串词用).
    const tasteText = Taste.renderTaste(Taste.readTaste(CLAUDIO_DIR), 'ta');
    const tasteReady = tasteState.status === 'ready' && !!tasteText.trim();

    const systemPrompt = MusicAgent.buildSystemPrompt(tasteText, tasteReady);
    const session = MusicAgent.newSession();
    const ttsProvider = buildTtsConfig().provider;

    const deps = {
      session,
      userId: userSession?.userId,
      cookie: userSession?.cookie,
      tasteText,
      tasteReady,
      ttsProvider,
      invokeLLM,
      getPlayerState: () => playerState,
      cityTimeWeather: cityTimeWeather(),
    };

    // No cold-start replay needed: the SQLite checkpointer already persists the full thread
    // across restarts (re-seeding from chat_history would duplicate context).
    const seedMessages: BaseMessage[] = [];

    // Open the SSE stream BEFORE acquiring the model. A config error (no LLM wired up) can then be
    // streamed back as a normal chat bubble — the client renders it through the live streaming path,
    // blinking cursor and all — instead of a 500 the client turns into an empty, cursor-less bubble.
    // Stream LangGraph's native events straight through as SSE (on_chat_model_stream /
    // on_tool_start / on_tool_end). No bespoke protocol; side effects ride the tools' on_tool_end.
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    (res as any).flushHeaders?.();
    const send = (ev: any) => res.write(`data: ${JSON.stringify(ev)}\n\n`);

    let model: ReturnType<typeof getLangchainModel>;
    try {
      model = getLangchainModel();
    } catch (cfgErr: any) {
      // No LLM configured (or bad config): tell the listener what's actually wrong, in-bubble. Streamed
      // as a chat_model_stream delta so it flows through the same path as any reply — the bubble shows
      // the message with a normally blinking cursor, then finalizes when the stream closes.
      log.warn('/api/chat · LLM not configured', { error: cfgErr?.message });
      send({
        event: 'on_chat_model_stream',
        name: '',
        run_id: 'config-error',
        data: {
          chunk: {
            content: `\n${cfgErr?.message || 'LLM 未配置'}\n\n电台后台还没接上「大脑」点击右上角的 Claudio Logo 进行设置吧！`,
          },
        },
      });
      res.end();
      return;
    }
    console.log('[Module B] Running DJ agent turn (streaming)...');

    // Record the turn's ordered text/tool blocks as events stream by, so the message we persist for
    // history renders identically on reload (same block shape the client builds live). Every event
    // that reaches the client goes through sendAndRecord so tool calls survive a refresh.
    const turnBlocks: any[] = [];
    const pushTurnText = (t: string) => {
      const last = turnBlocks[turnBlocks.length - 1];
      if (last && last.type === 'text') last.text += t;
      else turnBlocks.push({ type: 'text', text: t });
    };
    const recordEvent = (ev: any) => {
      switch (ev.event) {
        case 'on_chat_model_stream': {
          const t = ev.data?.chunk?.content || '';
          if (t) pushTurnText(t);
          break;
        }
        case 'on_tool_start':
          turnBlocks.push({
            type: 'tool',
            tool: { id: ev.run_id, name: ev.name, input: ev.data?.input, status: 'running' },
          });
          break;
        case 'on_tool_end': {
          const blk = [...turnBlocks]
            .reverse()
            .find((b) => b.type === 'tool' && b.tool.id === ev.run_id);
          if (blk) {
            blk.tool.output = ev.data?.output ?? '';
            blk.tool.status = 'done';
          }
          break;
        }
      }
    };
    const sendAndRecord = (ev: any) => {
      recordEvent(ev);
      send(ev);
    };
    // Server-originated lines reuse LangGraph's native event shapes so the client needs no special case.
    const emitText = (text: string) =>
      sendAndRecord({
        event: 'on_chat_model_stream',
        name: '',
        run_id: 'server',
        data: { chunk: { content: text } },
      });

    let replyText = '';
    let agentFailed = false;
    try {
      replyText = await MusicAgent.runAssistantTurnStream({
        model,
        deps,
        systemPrompt,
        history: [],
        userMessage: message,
        checkpointer: agentCheckpointer,
        // recursionLimit counts LangGraph supersteps. Our toolset is just the music/player tools
        // (createAgent, no injected coding tools), so a normal search→commit turn spends well under
        // 15; 60 leaves headroom for multi-step playlists while salvageCommit catches a runaway.
        threadConfig: { ...AGENT_THREAD_CONFIG, recursionLimit: 60 },
        seedMessages,
        onEvent: sendAndRecord,
      });
    } catch (agentErr: any) {
      console.error('[Module B] agent loop failed:', agentErr);
      agentFailed = true;
    }

    // Safety net: agent searched but never committed (e.g. looped to the recursion limit) → commit
    // the candidates it already surfaced. Deliver it like any tool effect: a (synthetic) commit_queue
    // on_tool_end carrying the queue, so the client handles it through the same native path.
    const salvaged = MusicAgent.salvageCommit(session, 8);
    if (salvaged) {
      log.warn(`/api/chat · salvaged ${salvaged} songs (agent never committed)`);
      sendAndRecord({
        event: 'on_tool_end',
        name: 'commit_queue',
        run_id: 'salvage',
        data: {
          output: JSON.stringify({ op: 'set', theme: '', count: salvaged, queue: session.queue }),
        },
      });
    }

    if (agentFailed) {
      replyText = salvaged
        ? `歌单先给你铺上了，慢慢听——想换风格随时说。`
        : '信号有点不稳，我先在这条频率上陪你。慢慢说，想听什么我来找。';
      emitText(`\n\n${replyText}`);
    } else if (salvaged) {
      const note = `（先把刚找到的 ${salvaged} 首铺上了，想换风格随时说）`;
      emitText(`\n\n${note}`);
      replyText = `${replyText}\n\n${note}`.trim();
    }

    // Empty-promise backstop. The model sometimes makes a forward-looking playlist promise ("来点…
    // 十二首 / 换一批 / 这就放") but never actually searches or commits — the worst seen case: on "换点"
    // it calls personal_fm(stop) to kill the stream first, then promises a playlist it never builds,
    // leaving dead air behind an empty promise. salvageCommit can't help (no candidates were ever
    // surfaced) and the FM backstop stays quiet (the stop genuinely happened, so it's not a lie). So
    // when this turn committed NO queue, salvage found nothing, and the reply reads like a playlist
    // promise, fetch a real taste-based fallback and commit it the same synthetic way — the words stop
    // being a lie and music actually plays. Gated on "nothing got played this turn", so it can't
    // hijack a turn that legitimately committed or merely answered a question.
    if (!agentFailed && !session.queueOp) {
      const txt = replyText.replace(/\s+/g, '');
      const promisedPlaylist =
        /([一二三四五六七八九十两百\d]+\s*首)|来点|来些|来一?批|换一?批|换一?组|换一?波|铺一?单|铺一?张|铺满|安排上|这就放|给你放|放一?批|整一?单|来一?单/.test(
          txt,
        );
      if (promisedPlaylist) {
        try {
          const picked = (await getDefaultRecommendations(deps.cookie)).slice(0, 12);
          if (picked.length) {
            session.queue = picked.map((s) => toTrack(s, 'taste'));
            session.queueOp = 'set';
            session.autoplay = true;
            session.playerOp = 'play';
            session.personalFm = false; // commit_queue(set) supersedes FM anyway
            log.warn(
              `/api/chat · empty-promise backstop: reply promised a playlist but nothing was committed/salvageable → committed ${session.queue.length} fallback recs`,
            );
            sendAndRecord({
              event: 'on_tool_end',
              name: 'commit_queue',
              run_id: 'promise-backstop',
              data: {
                output: JSON.stringify({
                  op: 'set',
                  theme: '',
                  count: session.queue.length,
                  queue: session.queue,
                }),
              },
            });
          }
        } catch (e: any) {
          log.warn(`/api/chat · empty-promise backstop fetch failed`, { error: e?.message });
        }
      }
    }

    // FM hallucination backstop. On terse input ("fm", "开个fm") the model tends to SAY "私人 FM 已开启"
    // without actually calling personal_fm — the confirmation then rides nothing, so the client never
    // starts the stream (the "说开了却没开" bug). If the reply asserts an FM start/stop that the tool
    // never performed, synthesize the op so the words aren't a lie. Mirrors salvageCommit for queues.
    // Gated tightly to avoid hijacking truthful status reports (those say "关闭状态/开着", not "已开启"),
    // and only fires when it would actually change the current (client-mirrored) FM state.
    if (!agentFailed && session.personalFm === null) {
      const txt = replyText.replace(/\s+/g, '');
      const mentionsFm = /(?:私人)?FM/i.test(txt);
      const negated = /(无法|没法|关闭|已关|没开|未开|别开|不开|不能开|要不要|是否)/.test(txt);
      const claimsStart =
        mentionsFm &&
        !negated &&
        /(已开启|已打开|已为你开|开启了|打开了|开好了|帮你开了|已开通|已开)/.test(txt);
      const claimsStop = mentionsFm && /(已关闭|已关掉|关掉了|已停止|已为你关|帮你关了)/.test(txt);
      let inject: boolean | null = null;
      // Start (or resume): fire when FM is off, OR when it's on but NOT currently playing (paused or
      // stopped both mean "not on air"). The client treats personal_fm(on) idempotently and resumes
      // playback, matching "fm" = 接着听. Only a genuinely playing stream needs no action.
      if (claimsStart && (!playerState.personalFm || playerState.status !== 'playing'))
        inject = true;
      else if (claimsStop && playerState.personalFm) inject = false;
      if (inject !== null) {
        session.personalFm = inject;
        log.warn(
          `/api/chat · FM backstop: reply claimed FM ${inject ? 'on' : 'off'} but personal_fm never fired — synthesizing op`,
        );
        sendAndRecord({
          event: 'on_tool_end',
          name: 'personal_fm',
          run_id: 'fm-backstop',
          data: { output: JSON.stringify({ op: 'personal_fm', on: inject }) },
        });
      }
    }

    // Narration (串词) hallucination backstop — same shape as the FM one above. The model often SAYS
    // "已关掉串词，不打断专注" (esp. for study scenes) without actually calling narration_mode, so the
    // 串词 keeps playing and the words are a lie. If the reply claims it toggled narration but the tool
    // never fired, synthesize the op. Gated by an explicit 串词/报幕/解说 mention + a clear on/off verb,
    // and only fires when it would actually change the current (client-mirrored) narration state.
    if (!agentFailed && session.fmMode === null) {
      const txt = replyText.replace(/\s+/g, '');
      const mentionsNarration = /(串词|报幕|解说|口播|旁白)/.test(txt);
      const claimsOff =
        mentionsNarration &&
        /(关掉|关闭|已关|关了|去掉|去了|不报幕|不解说|不打断|不打扰)/.test(txt);
      const claimsOn = mentionsNarration && /(开启|打开|已开|开了|加上|带上|配上|报幕了)/.test(txt);
      let inject: boolean | null = null;
      if (claimsOff && playerState.narration) inject = false;
      else if (claimsOn && !playerState.narration) inject = true;
      if (inject !== null) {
        session.fmMode = inject;
        log.warn(
          `/api/chat · narration backstop: reply claimed 串词 ${inject ? 'on' : 'off'} but narration_mode never fired — synthesizing op`,
        );
        sendAndRecord({
          event: 'on_tool_end',
          name: 'narration_mode',
          run_id: 'narration-backstop',
          data: { output: JSON.stringify({ op: 'fm', on: inject }) },
        });
      }
    }

    applySessionToPlayer(session);
    log.info(`/api/chat ▶ response summary`, {
      replyPreview: replyText.slice(0, 120),
      queueOp: session.queueOp,
      queueLen: session.queue.length,
      autoplay: session.autoplay,
      playerOp: session.playerOp,
      playerState: {
        status: playerState.status,
        currentIndex: playerState.currentIndex,
        queueLen: playerState.queue.length,
      },
    });

    // Persist the DJ reply for history reload, including the ordered text/tool blocks (so tool calls
    // survive a refresh) and the committed playlist (so the "play this playlist" button still works).
    const committedQueue = session.queueOp === 'set' ? session.queue : [];
    const claudioMsg: any = {
      id: Math.random().toString(),
      sender: 'claudio',
      text: replyText,
      timestamp: timestampStr,
      avatarUrl:
        'https://images.unsplash.com/photo-1570295999919-56ceb5ecca61?auto=format&fit=crop&q=80&w=120',
    };
    if (turnBlocks.length) claudioMsg.blocks = turnBlocks;
    if (committedQueue.length) claudioMsg.queue = committedQueue;
    appendChatMessage(claudioMsg);
    res.end();
  } catch (error: any) {
    console.error('Chat Server Error:', error);
    if (res.headersSent) {
      try {
        res.write(
          `data: ${JSON.stringify({ event: 'on_chat_model_stream', name: '', run_id: 'error', data: { chunk: { content: '\n\n信号断了一下，请再说一次。' } } })}\n\n`,
        );
      } catch {
        /* socket gone */
      }
      res.end();
    } else {
      res
        .status(500)
        .json({ error: 'Could not sync broadcast signal accurately.', details: error.message });
    }
  }
});

async function startServer() {
  // Fetch the enhanced API's anonymous token + xeapi public key so encrypted endpoints
  // (cloudsearch / song_url …) work; non-blocking so a slow/failed fetch won't stall boot.
  initNeteaseConfig().catch(() => {});

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        // Don't let the dev server full-reload the page when the backend writes runtime data
        // inside the project dir (chat history / queue / taste / session). Those reloads wipe
        // React state mid-session — the freshly-set queue and "playing" status disappear.
        watch: {
          ignored: [
            path.resolve(CLAUDIO_DIR) + '/**',
            '**/.claudio/**',
            '**/conversations.db',
            path.resolve(process.cwd(), 'agent-workspace') + '/**',
          ],
        },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
    console.log('Vite development server mounted');
  } else {
    const distPath = path.join(APP_ROOT, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
    console.log('Serving production static assets from dist');
  }

  app.listen(PORT, HOST, () => {
    console.log(`Claudio Server broadcasting on ${HOST}:${PORT}`);
  });
}

startServer();
