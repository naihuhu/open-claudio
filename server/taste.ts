// Module A: 品味档案生成 (SPEC «模块 A»).
// Lifecycle state machine + richer Netease sourcing (listen freq + liked + self-built playlists)
// + atomic taste.md write + liked_songs.jsonl cache. Module B reads taste.md only.
import fs from 'fs';
import path from 'path';
import { getLikedIds, getSongDetails, /* getListenRecord, */ RawSong } from './netease';
import { makeLogger } from './logger';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const log = makeLogger('ModuleA');

// Profile pronoun placeholder. The profile body is written once with {P} standing in for the
// listener; renderTaste() swaps it at use-time — "你" for the user-facing view, "ta" for the
// DJ/selection agents (信号同一份正文，两处复用). See reference: music_taste.py {P}.
const PRONOUN = '{P}';

export function renderTaste(text: string, pronoun = '你'): string {
  return text.split(PRONOUN).join(pronoun);
}

// ── Artist-weighted aggregation ───────────────────────────────────────
// The signal lives in the artist, not the single track: dedupe to「艺人 + 权重」where the weight
// (heavier rotation / more liked tracks = bigger) is what represents the preference.
function normalizeArtist(artist: string): string {
  // Drop "feat./ft./featuring 嘉宾" guest credits → fold into the primary artist. Deliberately do
  // NOT split on & / , — names like "Simon & Garfunkel"、"Earth, Wind & Fire" contain them.
  const primary = artist.split(/\s*[([]?\s*(?:feat\.?|ft\.?|featuring)\s+/i)[0];
  return primary.replace(/[ ([\-]+$/, '').trim() || artist;
}

interface ArtistRow {
  artist?: string;
  playCount?: number;
}
function aggregateArtists(
  ...sources: { rows: ArtistRow[]; weight: (r: ArtistRow) => number }[]
): [string, number][] {
  const w = new Map<string, number>();
  for (const { rows, weight } of sources) {
    for (const r of rows) {
      if (!r.artist) continue;
      const key = normalizeArtist(r.artist);
      if (key) w.set(key, (w.get(key) || 0) + weight(r));
    }
  }
  return [...w.entries()].sort((a, b) => b[1] - a[1]);
}

function formatArtistList(counts: [string, number][], topN = 80): string {
  return counts
    .slice(0, topN)
    .map(([n, c]) => `${n} (${c})`)
    .join('\n');
}

// ── Output parsing: <observations> / <profile> / <tags> ───────────────
const SECTION_TAGS = ['observations', 'profile', 'tags'];

// Extract one labelled section. Prefer a well-formed <tag>…</tag>, but tolerate the model omitting
// the closing tag (a real failure mode — see TASTE.md regressions): fall back to「opening tag → next
// section's tag or EOF」so observations never leak into the visible profile when </…> is missing.
function extractBlock(tag: string, text: string): string {
  const closed = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
  if (closed) return closed[1].trim();
  const open = text.match(new RegExp(`<${tag}>([\\s\\S]*)`, 'i'));
  if (!open) return '';
  let cut = open[1].length;
  for (const other of SECTION_TAGS) {
    if (other === tag) continue;
    const at = open[1].search(new RegExp(`</?${other}>`, 'i'));
    if (at >= 0) cut = Math.min(cut, at);
  }
  return open[1]
    .slice(0, cut)
    .replace(new RegExp(`</${tag}>`, 'i'), '')
    .trim();
}

export interface TasteTags {
  microGenres: string[]; // 微流派 — directly usable as search keywords
  moods: string[]; // 情绪
  sonics: string[]; // 声音质地 — arrangement palette / sonic texture
  vocals: string[]; // 人声特质 — vocal timbre & enunciation
  eras: string[]; // 年代
  regions: string[]; // 地域/语种
  scenes: string[]; // 收听场景 — listening moments
}

const TAG_FIELDS: [keyof TasteTags, RegExp][] = [
  ['microGenres', /微流派/],
  ['moods', /情绪/],
  ['sonics', /声音|音色|质地/],
  ['vocals', /人声|声线/],
  ['eras', /年代/],
  ['regions', /地域|语种/],
  ['scenes', /场景|时刻/],
];

// Parse the「## 标签」block out of a taste doc into structured arrays the playlist engine consumes.
export function parseTasteTags(doc: string): TasteTags {
  const out: TasteTags = {
    microGenres: [],
    moods: [],
    sonics: [],
    vocals: [],
    eras: [],
    regions: [],
    scenes: [],
  };
  if (!doc) return out;
  for (const line of doc.split(/\r?\n/)) {
    const m = line.match(/^[\s>*-]*([^:：]{1,12})[:：]\s*(.+)$/);
    if (!m) continue;
    for (const [key, re] of TAG_FIELDS) {
      if (re.test(m[1])) {
        out[key] = m[2]
          .split(/[、,，/／|]+/)
          .map((s) => s.trim())
          .filter((s) => s && !/^(无|暂无|不详|未知|none)$/i.test(s));
        break;
      }
    }
  }
  return out;
}

function assembleTasteDoc(profile: string, tagsBlock: string): string {
  const tags =
    tagsBlock.trim() ||
    '微流派: 暂无\n情绪: 暂无\n声音质地: 暂无\n人声特质: 暂无\n年代: 暂无\n地域/语种: 暂无\n收听场景: 暂无';
  return `# 品味画像\n\n${profile.trim()}\n\n---\n\n## 音乐标签\n${tags}\n`;
}

export type TasteStatus = 'none' | 'prompted' | 'generating' | 'ready' | 'skipped' | 'failed';

export interface TasteState {
  status: TasteStatus;
  snapshotAt?: string; // when underlying music data was snapshotted
  updatedAt?: string;
  reason?: string; // failure classification: auth | empty | service
}

function tasteFile(dir: string) {
  return path.join(dir, 'TASTE.md');
}
function stateFile(dir: string) {
  return path.join(dir, 'taste.state.json');
}
function likedJsonl(musicDir: string) {
  return path.join(musicDir, 'liked_songs.jsonl');
}

export function readTasteState(dir: string): TasteState {
  try {
    if (fs.existsSync(stateFile(dir))) {
      return JSON.parse(fs.readFileSync(stateFile(dir), 'utf-8'));
    }
  } catch {
    /* fall through */
  }
  // Infer from presence of taste.md when no explicit state recorded.
  return { status: fs.existsSync(tasteFile(dir)) ? 'ready' : 'none' };
}

export function writeTasteState(dir: string, patch: Partial<TasteState>) {
  const cur = readTasteState(dir);
  const next: TasteState = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  try {
    fs.writeFileSync(stateFile(dir), JSON.stringify(next, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Taste] failed to write state:', err);
  }
  return next;
}

export function readTaste(dir: string): string {
  try {
    if (fs.existsSync(tasteFile(dir))) return fs.readFileSync(tasteFile(dir), 'utf-8');
  } catch {
    /* ignore */
  }
  return '';
}

// Atomic write: temp file → rename so a crash never corrupts the old profile (A-R3).
function atomicWriteTaste(dir: string, content: string) {
  const tmp = tasteFile(dir) + '.tmp';
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, tasteFile(dir));
}

// 品味数据采集：只拉「红心 + 全部自建歌单」的歌曲列表（getTasteLibrary，与选歌分离、自带限速），
// 去重后按「艺人 + 歌曲数」汇总——歌曲数即权重。不再取听歌排行/风格偏好等其它信号。
const TASTE_RATE_MS = Number(process.env.NETEASE_TASTE_RATE_MS || 1000);

export async function gatherMusicData(
  userId: number,
  cookie: string | undefined,
  musicDir: string,
  onProgress?: (stage: 'fetching' | 'analyzing') => void,
) {
  onProgress?.('fetching');
  log.info(`gatherMusicData ◀ start (userId=${userId}, rateLimitMs=${TASTE_RATE_MS})`);

  // ① 听歌排行前 100（歌名 + 播放次数）。优先所有时间，空了退回本周。
  // —— 暂时注释掉听歌排行，只用红心信号。
  // let listenRaw = await getListenRecord(userId, cookie, 0);
  // if (!listenRaw.length) { await sleep(TASTE_RATE_MS); listenRaw = await getListenRecord(userId, cookie, 1); }
  // const listenTop100 = listenRaw.slice(0, 100).map((r: any) => ({
  //   name: r.song?.name,
  //   artist: (r.song?.ar || []).map((a: any) => a.name).filter(Boolean).join(", "),
  //   playCount: r.playCount,
  // }));
  const listenTop100: { name?: string; artist: string; playCount?: number }[] = [];

  // ② 拉全部红心歌曲，去重后按主艺人归堆（一首歌=一票），仅保留歌曲数最多的前 520 位歌手。
  const likedIds = await getLikedIds(userId, cookie);
  await sleep(TASTE_RATE_MS);
  const library = await getSongDetails(likedIds, cookie);
  const artistCounts = aggregateArtists({ rows: library, weight: () => 1 }).slice(0, 520);

  // Cache the gathered songs to liked_songs.jsonl (JSONL per storage convention; debug/reuse).
  try {
    const lines = library.map((s: RawSong) => JSON.stringify(s)).join('\n');
    fs.writeFileSync(likedJsonl(musicDir), lines + (lines ? '\n' : ''), 'utf-8');
  } catch (err) {
    console.warn('[Taste] failed to write liked_songs.jsonl:', err);
  }

  const result = {
    songCount: library.length,
    artistCounts,
    listenTop100,
  };
  log.info(`gatherMusicData ▶ done`, {
    songCount: result.songCount,
    artistCount: artistCounts.length,
    listenTop100Count: listenTop100.length,
    topArtists: artistCounts.slice(0, 10),
  });
  return result;
}

export interface GenerateParams {
  claudioDir: string;
  musicDir: string;
  userId: number;
  cookie?: string;
  invokeLLM: (system: string, user: string) => Promise<string>;
  offlineFallback: (data: any) => string; // rule-based degrade when no LLM
  onProgress?: (stage: 'fetching' | 'analyzing') => void;
}

// Load taste-profile-generation.md template and substitute {{MUSIC_DATA}}.
function loadPromptTemplate(): string | null {
  // CLAUDIO_APP_ROOT: set by the Electron desktop build (assets live in app.asar,
  // where process.cwd() can't point). Falls back to cwd for dev / `npm start`.
  const appRoot = process.env.CLAUDIO_APP_ROOT || process.cwd();
  const candidates = [
    path.join(appRoot, 'taste-profile-generation.md'),
    path.join(appRoot, 'prompts', 'taste-profile-generation.md'),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return fs.readFileSync(c, 'utf-8');
    } catch {
      /* ignore */
    }
  }
  return null;
}

export async function generateTasteProfile(
  p: GenerateParams,
): Promise<{ taste: string; state: TasteState }> {
  log.info('generateTasteProfile ◀ start; state → generating');
  writeTasteState(p.claudioDir, { status: 'generating' });
  try {
    const data = await gatherMusicData(p.userId, p.cookie, p.musicDir, p.onProgress);

    if (data.songCount === 0 && data.listenTop100.length === 0) {
      log.warn('generateTasteProfile: empty music data → state failed(empty)');
      const state = writeTasteState(p.claudioDir, { status: 'failed', reason: 'empty' });
      throw Object.assign(new Error('No music data available to analyze.'), {
        classification: 'empty',
        state,
      });
    }

    p.onProgress?.('analyzing');

    // 只喂一块：艺人权重表（全部红心去重后 top 520 歌手）。听歌排行暂时注释掉。
    const artistText = formatArtistList(data.artistCounts, 520);
    // const listenText = data.listenTop100.map((s) => `${s.name} (${s.playCount})`).join("\n") || "(无听歌记录)";
    const payload = `[艺人权重表 · 全部红心歌曲去重后，按歌曲数降序保留前 520 位歌手（括号内=歌曲数，越大越能代表偏好；信号在艺人不在单曲）]\n${artistText}`;
    // + `\n\n[听歌排行 · 最常听的歌前 100（括号内=播放次数，反映实际在反复听什么）]\n${listenText}`;

    const template = loadPromptTemplate();
    const system =
      '你是 Claudio 电台的音乐品味分析师。严格按 <observations>/<profile>/<tags> 三段输出，每段都必须有闭合标签（</observations></profile></tags>）。先在 observations 内部取证，再写面向用户的 profile（人称一律用占位符 {P}），最后写 tags——tags 必须逐行『中文键: 值』（如「微流派: …」），绝不写成 JSON、绝不用英文键。零虚构，不认识的艺人就别编它的风格。';
    const userPrompt = template
      ? template.replace('{{MUSIC_DATA}}', payload)
      : `这是某用户歌单去重后的艺人权重表与补充明细。请输出 <observations>/<profile>/<tags> 三段中文画像，profile 人称用 {P}，结论须可由数据支撑、不虚构：\n\n${payload}`;

    log.info(
      `LLM taste prompt (template=${!!template})`,
      { system, user: userPrompt },
      { full: true },
    );
    let raw = '';
    try {
      raw = await p.invokeLLM(system, userPrompt);
      log.info('LLM taste output', raw, { full: true });
    } catch (llmErr: any) {
      log.warn('LLM generation failed, using offline fallback', { error: llmErr.message });
      raw = p.offlineFallback(data);
      log.info('offline-fallback taste output', raw, { full: true });
    }
    if (!raw || !raw.trim()) {
      raw = p.offlineFallback(data);
      log.warn('empty LLM output → offline fallback');
    }

    // 两段式取证：observations 仅记日志(不展示)，profile + tags 落档。
    const observations = extractBlock('observations', raw);
    const profile = extractBlock('profile', raw);
    const tagsBlock = extractBlock('tags', raw);
    if (observations) log.info('taste observations (internal)', observations, { full: true });

    // 模型若没按块输出(如离线兜底/旧格式)，整段当 profile 用，tags 走默认占位。
    const taste = profile
      ? assembleTasteDoc(profile, tagsBlock)
      : raw.includes('# 品味画像')
        ? raw
        : assembleTasteDoc(raw, '');

    // Lint: if the model wrote literal 你/您 instead of {P}, the dual-render replace won't reach them.
    const strays = ['你', '您'].filter((w) => renderTaste(profile, '').includes(w));
    log.info('parsed taste tags', { tags: parseTasteTags(taste), strayPronouns: strays });

    atomicWriteTaste(p.claudioDir, taste);
    const state = writeTasteState(p.claudioDir, {
      status: 'ready',
      snapshotAt: new Date().toISOString(),
    });
    log.info('generateTasteProfile ▶ done; state → ready; taste.md written atomically');
    return { taste, state };
  } catch (err: any) {
    if (err.classification) throw err; // already recorded failed state
    log.error('generateTasteProfile failed → state failed(service)', { error: err.message });
    writeTasteState(p.claudioDir, { status: 'failed', reason: 'service' });
    throw err;
  }
}
