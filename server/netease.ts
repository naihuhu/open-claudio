// Netease Cloud Music API wrapper (in-process NPM package, no HTTP forwarding).
// Per SPEC «音乐平台 API：技术栈与接入» — all module A/B data sourcing flows through here.
import neteaseApi from '@neteasecloudmusicapienhanced/api';
import { createRequire } from 'module';
import { makeLogger, songPreview } from './logger';

const api: any = (neteaseApi as any).default || neteaseApi;
const log = makeLogger('MusicAPI');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Mask cookie in logs (show only that it's present + length).
function ck(cookie?: string) {
  return cookie ? `present(len=${cookie.length})` : 'none';
}

// The Enhanced fork encrypts some endpoints (cloudsearch, song/url, …) with "xeapi", which
// needs an anonymous token + a public key fetched at runtime via generateConfig() — the
// package's own bootstrap (app.js) does this, but module usage skips it. Run it once on
// startup (and refresh periodically) or those endpoints throw "xeapi public key is missing".
// Works in both module formats: __filename exists in the CJS build (dist/server.cjs,
// what Electron/`npm start` run), import.meta.url in the ESM dev path (tsx).
const _require = createRequire(typeof __filename === 'string' ? __filename : import.meta.url);
let _configPromise: Promise<void> | null = null;

export function initNeteaseConfig(force = false): Promise<void> {
  if (force) _configPromise = null;
  if (!_configPromise) {
    _configPromise = (async () => {
      try {
        const generateConfig = _require('@neteasecloudmusicapienhanced/api/generateConfig');
        await generateConfig();
        console.log('[Netease] enhanced config ready (anonymous_token + xeapi public key).');
      } catch (err: any) {
        console.warn(
          '[Netease] generateConfig failed (encrypted endpoints may fail):',
          err.message,
        );
        _configPromise = null; // allow a later retry
      }
    })();
  }
  return _configPromise;
}

// Refresh keys periodically (token/public key rotate). Safe no-op if startup already ran it.
setInterval(() => initNeteaseConfig(true).catch(() => {}), 6 * 60 * 60 * 1000).unref?.();

// Unified track shape consumed by the player UI (matches web/App.tsx Track interface
// plus a few internal fields used by the playlist engine).
export interface Track {
  id: string; // "netease-<songId>"
  title: string;
  artist: string;
  album: string;
  duration: number; // seconds
  url: string;
  story: string; // narration text (filled at queue time, falls back to a stub)
  // Internal scoring fields (not required by the UI):
  songId?: number;
  source?: 'library' | 'taste' | 'explore';
  tags?: string[];
  year?: number | null;
  reason?: string;
}

export interface RawSong {
  id: number;
  name: string;
  artist: string;
  album: string;
  duration: number;
  year?: number | null;
}

// Normalize a cloudsearch / song_detail song object into RawSong.
export function mapSong(song: any): RawSong {
  const ar = song.ar || song.artists || [];
  const al = song.al || song.album || {};
  return {
    id: song.id,
    name: song.name,
    artist:
      ar
        .map((a: any) => a.name)
        .filter(Boolean)
        .join(', ') || 'Unknown Artist',
    album: al.name || 'Unknown Album',
    duration: Math.round((song.dt || song.duration || 180000) / 1000),
    year: al.publishTime ? new Date(al.publishTime).getFullYear() : null,
  };
}

export async function resolvePlayUrl(songId: number | string, cookie?: string): Promise<string> {
  const outer = `https://music.163.com/song/media/outer/url?id=${songId}.mp3`;
  await initNeteaseConfig();
  try {
    // Ask for the best tier first (VIP/entitled users get lossless). But when an account isn't
    // entitled to the requested tier, Netease doesn't downgrade — it returns a ~30s `freeTrialInfo`
    // clip of that tier. Detect that and re-fetch at "standard", where a fee=8 (free-to-play) song
    // hands back the FULL track. exhigh → standard is the difference between a 30s preview and the
    // whole song for non-VIP listeners.
    for (const level of ['exhigh', 'standard'] as const) {
      log.info(`song_url_v1 ◀ input`, { id: songId, level, cookie: ck(cookie) });
      const result = await api.song_url_v1({ id: songId, level, cookie });
      const d = result.body?.data?.[0];
      const url = d?.url;
      const trial = !!d?.freeTrialInfo;
      log.info(`song_url_v1 ▶ output`, {
        id: songId,
        level,
        code: result.body?.code,
        hasUrl: !!url,
        fee: d?.fee,
        trial,
        time: d?.time,
        url: url || null,
      });
      if (url && !trial) return url; // full track — use it
      if (level === 'standard' && url) return url; // already lowest tier; take what we got
      // else: got a trial clip at this tier — loop down to "standard" and try again
    }
  } catch (err: any) {
    log.warn(`song_url_v1 failed for ${songId}, using outer link`, { error: err.message });
  }
  return outer;
}

// Playability check for a batch of song ids. Asks song_url_v1 for real CDN urls using THIS user's
// cookie, so VIP / region / copyright rights are accounted for: a song that comes back with a null
// url is one the current user genuinely can't play (VIP-only, pulled, no copyright) — exactly the
// dead tracks that stutter or auto-skip in the player. Returns the subset of ids (as `netease-<id>`)
// that have a real url. One call covers the whole batch (song_url_v1 takes comma-separated ids).
// Fails OPEN — on any error it returns all ids as "playable" so a check outage never nukes a queue.
export async function checkPlayableIds(
  ids: Array<number | string>,
  cookie?: string,
): Promise<Set<string>> {
  const norm = ids.map((x) => String(x).replace(/^netease-/, '')).filter(Boolean);
  if (norm.length === 0) return new Set();
  await initNeteaseConfig();
  try {
    // "standard" (not exhigh): we only care whether ANY playable stream exists for this user, and a
    // lower tier is the most permissive — don't drop a song just because its lossless tier is gated.
    const result = await api.song_url_v1({ id: norm.join(','), level: 'standard', cookie });
    const data: any[] = result.body?.data || [];
    const ok = new Set<string>();
    // A url with `freeTrialInfo` is only a ~30s preview (VIP-only / unpurchased for this user) —
    // not genuinely playable. Require a real url AND no trial flag, so the DJ skips 30s songs.
    for (const d of data) if (d?.url && !d.freeTrialInfo) ok.add(`netease-${d.id}`);
    log.info(`checkPlayableIds ▶ ${ok.size}/${norm.length} playable`, {
      unplayable: norm.length - ok.size,
    });
    // If the API answered but flagged NOTHING playable, treat it as inconclusive and fail open
    // rather than committing an empty queue.
    return ok.size === 0 ? new Set(norm.map((x) => `netease-${x}`)) : ok;
  } catch (err: any) {
    log.warn(`checkPlayableIds failed, treating all as playable`, { error: err.message });
    return new Set(norm.map((x) => `netease-${x}`));
  }
}

// ---- Search (search_songs底层) ----
export async function searchSongs(
  keyword: string,
  limit = 20,
  cookie?: string,
): Promise<RawSong[]> {
  await initNeteaseConfig();
  log.info(`cloudsearch ◀ input`, { keywords: keyword, limit, cookie: ck(cookie) });
  try {
    const result = await api.cloudsearch({ keywords: keyword, limit, cookie });
    const songs = (result.body?.result?.songs || []).map(mapSong);
    log.info(`cloudsearch ▶ output (${songs.length} songs) for "${keyword}"`, songPreview(songs));
    return songs;
  } catch (err: any) {
    log.warn(`cloudsearch failed for "${keyword}"`, { error: err.message });
    return [];
  }
}

// ---- 存量库 (search_my_library 底层): liked + self-built playlists ----
let likedCache: { ids: number[]; at: number } | null = null;
export async function getLikedIds(userId: number, cookie?: string): Promise<number[]> {
  if (likedCache && Date.now() - likedCache.at < 5 * 60_000) {
    log.info(`likelist ▶ output (cache hit, ${likedCache.ids.length} ids)`);
    return likedCache.ids;
  }
  log.info(`likelist ◀ input`, { uid: userId, cookie: ck(cookie) });
  try {
    const result = await api.likelist({ uid: userId, cookie });
    const ids = result.body?.ids || [];
    likedCache = { ids, at: Date.now() };
    log.info(`likelist ▶ output (${ids.length} liked ids)`, { sample: ids.slice(0, 20) });
    return ids;
  } catch (err: any) {
    log.warn('likelist failed', { error: err.message });
    return [];
  }
}

// Is a single song in the user's 红心 (我喜欢的音乐) list? Reuses the cached likelist.
export async function isSongLiked(
  songId: number | string,
  userId: number,
  cookie?: string,
): Promise<boolean> {
  const id = Number(String(songId).replace(/^netease-/, ''));
  if (!id || !userId) return false;
  const ids = await getLikedIds(userId, cookie);
  return ids.includes(id);
}

// 用户的「我喜欢的音乐」(红心) 歌单 id —— specialType===5 唯一标识它，取不到时退回第一个自建歌单。
// 缓存住，避免每次取消红心都打一次 user_playlist。
let likedPlaylistCache: { id: number; uid: number } | null = null;
async function getLikedPlaylistId(userId: number, cookie?: string): Promise<number | null> {
  if (likedPlaylistCache && likedPlaylistCache.uid === userId) return likedPlaylistCache.id;
  try {
    const r = await api.user_playlist({ uid: userId, limit: 50, cookie });
    const playlists: any[] = r.body?.playlist || [];
    const liked = playlists.find((p) => p.specialType === 5) || playlists[0];
    if (!liked?.id) return null;
    likedPlaylistCache = { id: liked.id, uid: userId };
    log.info(`getLikedPlaylistId ▶ 红心歌单`, { uid: userId, pid: liked.id, name: liked.name });
    return liked.id;
  } catch (err: any) {
    log.warn(`getLikedPlaylistId failed`, { error: err.message });
    return null;
  }
}

// 标记/取消红心。like=true → 走 radio/like 加红心（也喂红心电台算法）。like=false → radio/like
// 返回 200 却经常并不真正从「我喜欢的音乐」移除，所以取消时再用 playlist/manipulate/tracks op=del
// 对红心歌单做权威删除。命中后让 likelist 缓存失效，下次 isSongLiked 拿到最新状态。
export async function setSongLike(
  songId: number | string,
  like: boolean,
  cookie?: string,
  userId?: number,
): Promise<boolean> {
  await initNeteaseConfig();
  const id = Number(String(songId).replace(/^netease-/, ''));
  if (!id) throw new Error('invalid song id');
  log.info(`like ◀ input`, { id, like, uid: userId, cookie: ck(cookie) });

  const r = await api.like({ id, like, cookie });
  const code = r.body?.code;
  if (code !== 200) {
    log.warn(`like ▶ failed`, { id, like, code, body: r.body });
    throw new Error(`like failed (code=${code})`);
  }

  // 取消时做权威删除：radio/like(like=false) 不可靠，从红心歌单直接 del。
  if (!like && userId) {
    const pid = await getLikedPlaylistId(userId, cookie);
    if (pid) {
      const del = await api.playlist_tracks({ op: 'del', pid, tracks: String(id), cookie });
      const delCode = del.body?.code;
      log.info(`playlist_tracks(del 红心) ▶`, { id, pid, code: delCode });
      if (delCode !== 200)
        log.warn(`playlist_tracks del 未成功`, { id, pid, code: delCode, body: del.body });
    } else {
      log.warn(`取消红心：拿不到红心歌单 id，仅依赖 radio/like`, { id, uid: userId });
    }
  }

  likedCache = null; // 失效缓存，强制下次重新拉 likelist
  log.info(`like ▶ ok`, { id, like });
  return like;
}

export async function getSongDetails(ids: number[], cookie?: string): Promise<RawSong[]> {
  if (ids.length === 0) return [];
  log.info(`song_detail ◀ input (${ids.length} ids)`, {
    sample: ids.slice(0, 20),
    cookie: ck(cookie),
  });
  const out: RawSong[] = [];
  // song_detail accepts comma-joined ids; chunk to be safe.
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    try {
      const result = await api.song_detail({ ids: chunk.join(','), cookie });
      const songs = result.body?.songs || [];
      out.push(...songs.map(mapSong));
    } catch (err: any) {
      log.warn('song_detail chunk failed', { offset: i, size: chunk.length, error: err.message });
    }
  }
  log.info(`song_detail ▶ output (${out.length} songs)`, songPreview(out));
  return out;
}

// User self-built playlists (excludes subscribed/others') → track ids.
export async function getMyLibrary(userId: number, cookie?: string): Promise<RawSong[]> {
  log.info(`getMyLibrary ◀ input (存量库: 红心 + 自建歌单)`, { uid: userId, cookie: ck(cookie) });
  const collected: RawSong[] = [];
  const seen = new Set<number>();

  // 1) Liked songs (红心)
  const likedIds = await getLikedIds(userId, cookie);
  const likedDetails = await getSongDetails(likedIds.slice(0, 300), cookie);
  for (const s of likedDetails) {
    if (!seen.has(s.id)) {
      seen.add(s.id);
      collected.push(s);
    }
  }

  log.info(`getMyLibrary · 红心 detail-filled`, {
    likedIds: likedIds.length,
    likedDetails: likedDetails.length,
  });

  // 2) Self-built playlists (creator === userId)
  try {
    const plRes = await api.user_playlist({ uid: userId, limit: 50, cookie });
    const playlists = (plRes.body?.playlist || []).filter(
      (p: any) => p.creator?.userId === userId || p.userId === userId,
    );
    log.info(
      `user_playlist ▶ ${playlists.length} self-built playlists`,
      playlists.slice(0, 10).map((p: any) => ({ id: p.id, name: p.name, count: p.trackCount })),
    );
    for (const pl of playlists.slice(0, 10)) {
      try {
        const tracksRes = await api.playlist_track_all({ id: pl.id, limit: 200, cookie });
        const songs = tracksRes.body?.songs || [];
        let added = 0;
        for (const s of songs.map(mapSong)) {
          if (!seen.has(s.id)) {
            seen.add(s.id);
            collected.push(s);
            added++;
          }
        }
        log.info(`playlist_track_all ▶ "${pl.name}" ${songs.length} songs (+${added} new)`);
      } catch {
        /* skip a bad playlist */
      }
    }
  } catch (err: any) {
    log.warn('user_playlist failed', { error: err.message });
  }

  log.info(
    `getMyLibrary ▶ output (存量库 total ${collected.length} unique songs)`,
    songPreview(collected),
  );
  return collected;
}

// ---- Module A 品味专用取数（与选歌的 getMyLibrary 分开，互不掺杂）----
// 只拉「红心 + 全部自建歌单」的歌曲列表，去重后交给品味分析按艺人+歌曲数汇总。自带 rateLimitMs
// 请求间隔限速；只有 Module A 品味生成会调它，不影响播放/选歌路径。
export async function getTasteLibrary(
  userId: number,
  cookie?: string,
  opts?: { rateLimitMs?: number },
): Promise<RawSong[]> {
  const gap = () => (opts?.rateLimitMs ? sleep(opts.rateLimitMs) : Promise.resolve());
  log.info(`getTasteLibrary ◀ input (品味存量: 红心 + 全部自建歌单)`, {
    uid: userId,
    cookie: ck(cookie),
    rateLimitMs: opts?.rateLimitMs || 0,
  });

  const collected: RawSong[] = [];
  const seen = new Set<number>();
  const add = (songs: RawSong[]) => {
    for (const s of songs)
      if (s.id && !seen.has(s.id)) {
        seen.add(s.id);
        collected.push(s);
      }
  };

  // 1) 红心歌单
  const likedIds = await getLikedIds(userId, cookie);
  await gap();
  add(await getSongDetails(likedIds.slice(0, 300), cookie));
  log.info(`getTasteLibrary · 红心 detail-filled`, {
    likedIds: likedIds.length,
    collected: collected.length,
  });

  // 2) 全部自建歌单（不设上限，逐个拉曲目；限速在每次请求前生效）
  try {
    await gap();
    const plRes = await api.user_playlist({ uid: userId, limit: 50, cookie });
    const playlists = (plRes.body?.playlist || []).filter(
      (p: any) => p.creator?.userId === userId || p.userId === userId,
    );
    log.info(
      `getTasteLibrary · user_playlist ▶ ${playlists.length} self-built playlists`,
      playlists.slice(0, 10).map((p: any) => ({ id: p.id, name: p.name, count: p.trackCount })),
    );
    for (const pl of playlists) {
      try {
        await gap();
        const tracksRes = await api.playlist_track_all({ id: pl.id, limit: 200, cookie });
        const raw = (tracksRes.body?.songs || []).map(mapSong);
        const before = collected.length;
        add(raw);
        log.info(
          `getTasteLibrary · "${pl.name}" ▶ ${raw.length} songs (+${collected.length - before} new)`,
        );
      } catch {
        /* skip a bad playlist */
      }
    }
  } catch (err: any) {
    log.warn('getTasteLibrary user_playlist failed', { error: err.message });
  }

  log.info(
    `getTasteLibrary ▶ output (品味存量 ${collected.length} unique songs)`,
    songPreview(collected),
  );
  return collected;
}

// Keyword filter over the in-memory library (search_my_library with keyword).
export function filterLibrary(library: RawSong[], keyword?: string): RawSong[] {
  if (!keyword || !keyword.trim()) return library;
  const terms = keyword.toLowerCase().split(/\s+/).filter(Boolean);
  return library.filter((s) => {
    const hay = `${s.name} ${s.artist} ${s.album}`.toLowerCase();
    return terms.some((t) => hay.includes(t));
  });
}

// ---- 品味契合路: platform personalized recommendation 现捞 ----
export async function getRecommendedSongs(cookie?: string): Promise<RawSong[]> {
  await initNeteaseConfig();
  log.info(`getRecommendedSongs ◀ input (品味契合路现捞)`, { cookie: ck(cookie) });
  const out: RawSong[] = [];
  if (cookie) {
    try {
      const res = await api.recommend_songs({ cookie });
      const songs = (res.body?.data?.dailySongs || res.body?.recommend || []).map(mapSong);
      out.push(...songs);
      log.info(`recommend_songs ▶ ${songs.length} daily-recommended songs`, songPreview(songs));
    } catch (err: any) {
      log.warn('recommend_songs failed', { error: err.message });
    }
  }
  // /personalized works without login: pull a few playlists then dig songs from one.
  try {
    const res = await api.personalized({ limit: 6, cookie });
    const playlists = res.body?.result || [];
    log.info(
      `personalized ▶ ${playlists.length} recommended playlists`,
      playlists.slice(0, 6).map((p: any) => ({ id: p.id, name: p.name })),
    );
    for (const pl of playlists.slice(0, 2)) {
      try {
        const tracksRes = await api.playlist_track_all({ id: pl.id, limit: 20, cookie });
        const songs = (tracksRes.body?.songs || []).map(mapSong);
        out.push(...songs);
        log.info(`personalized · "${pl.name}" ▶ ${songs.length} songs`);
      } catch {
        /* skip */
      }
    }
  } catch (err: any) {
    log.warn('personalized failed', { error: err.message });
  }
  log.info(`getRecommendedSongs ▶ output (${out.length} songs total)`);
  return out;
}

// ---- 免登录推荐（默认歌单用）：personalized_newsong 直接返回可播新歌，无需 cookie ----
let defaultRecCache: { songs: RawSong[]; at: number } | null = null;
export async function getDefaultRecommendations(cookie?: string): Promise<RawSong[]> {
  if (defaultRecCache && Date.now() - defaultRecCache.at < 30 * 60_000) {
    log.info(`getDefaultRecommendations ▶ output (cache hit, ${defaultRecCache.songs.length})`);
    return defaultRecCache.songs;
  }
  await initNeteaseConfig();
  log.info(`getDefaultRecommendations ◀ input (免登录推荐)`, { cookie: ck(cookie) });
  let out: RawSong[] = [];
  try {
    const r = await api.personalized_newsong({ limit: 30, cookie });
    out = (r.body?.result || []).map((x: any) => mapSong(x.song || x)).filter((s: RawSong) => s.id);
    log.info(`personalized_newsong ▶ ${out.length} songs`, songPreview(out));
  } catch (err: any) {
    log.warn('personalized_newsong failed', { error: err.message });
  }
  // Fallback: pull a recommended playlist's tracks.
  if (out.length === 0) {
    try {
      const r = await api.personalized({ limit: 3, cookie });
      const pl = r.body?.result?.[0];
      if (pl) {
        const t = await api.playlist_track_all({ id: pl.id, limit: 30, cookie });
        out = (t.body?.songs || []).map(mapSong);
        log.info(`personalized fallback ▶ "${pl.name}" ${out.length} songs`);
      }
    } catch (err: any) {
      log.warn('personalized fallback failed', { error: err.message });
    }
  }
  // dedupe by id
  const seen = new Set<number>();
  out = out.filter((s) => s.id && !seen.has(s.id) && seen.add(s.id));
  defaultRecCache = { songs: out, at: Date.now() };
  log.info(`getDefaultRecommendations ▶ output (${out.length} songs)`);
  return out;
}

// ---- 相邻探索路: 种子扩散 (similar songs / similar artists) ----
export async function getSimilarSongs(seedSongId: number, cookie?: string): Promise<RawSong[]> {
  await initNeteaseConfig();
  log.info(`simi_song ◀ input (种子扩散)`, { seedSongId, cookie: ck(cookie) });
  try {
    const res = await api.simi_song({ id: seedSongId, cookie });
    const songs = (res.body?.songs || []).map(mapSong);
    log.info(`simi_song ▶ output (${songs.length} similar to ${seedSongId})`, songPreview(songs));
    return songs;
  } catch (err: any) {
    log.warn(`simi_song failed for ${seedSongId}`, { error: err.message });
    return [];
  }
}

export async function getArtistTopSongs(artistId: number, cookie?: string): Promise<RawSong[]> {
  await initNeteaseConfig();
  log.info(`artist_top_song ◀ input`, { artistId, cookie: ck(cookie) });
  try {
    const res = await api.artist_top_song({ id: artistId, cookie });
    const songs = (res.body?.songs || []).map(mapSong);
    log.info(`artist_top_song ▶ output (${songs.length} songs)`, songPreview(songs));
    return songs;
  } catch (err: any) {
    log.warn(`artist_top_song failed for ${artistId}`, { error: err.message });
    return [];
  }
}

// ---- Module A 听歌行为数据 ----
export async function getListenRecord(userId: number, cookie?: string, type = 0): Promise<any[]> {
  log.info(`user_record ◀ input`, {
    uid: userId,
    type: `${type} (${type === 1 ? '本周' : '所有时间'})`,
    cookie: ck(cookie),
  });
  try {
    const res = await api.user_record({ uid: userId, type, cookie });
    const data = res.body?.allData || res.body?.weekData || [];
    log.info(
      `user_record ▶ output (${data.length} ranked songs, with playCount)`,
      data.slice(0, 20).map((r: any) => ({
        name: r.song?.name,
        artist: (r.song?.ar || []).map((a: any) => a.name).join(', '),
        playCount: r.playCount,
      })),
    );
    return data;
  } catch (err: any) {
    log.warn('user_record failed', { error: err.message });
    return [];
  }
}

// Per-song style/mood tags via song_wiki_summary → feeds the narration prompt so the DJ's tone
// matches the song's actual genre/vibe (e.g. 乡村摇滚 / 华语流行-民谣) instead of defaulting to 深夜.
const songTagCache = new Map<string, string>();
export async function getSongTags(songId: number | string, cookie?: string): Promise<string> {
  const key = String(songId);
  if (songTagCache.has(key)) return songTagCache.get(key)!;
  await initNeteaseConfig();
  let tags = '';
  try {
    const r = await api.song_wiki_summary({ id: songId, cookie });
    const basic = (r.body?.data?.blocks || []).find(
      (b: any) => b.code === 'SONG_PLAY_ABOUT_SONG_BASIC',
    );
    const parts: string[] = [];
    for (const c of basic?.creatives || []) {
      if (c.creativeType !== 'songTag') continue;
      const label = c.uiElement?.mainTitle?.title;
      const vals = (c.resources || [])
        .map((x: any) => x.uiElement?.mainTitle?.title)
        .filter(Boolean);
      if (label && vals.length) parts.push(`${label}: ${vals.join('、')}`);
    }
    tags = parts.join('; ');
  } catch (err: any) {
    log.warn(`song_wiki_summary failed for ${songId}`, { error: err.message });
  }
  log.info(`getSongTags ▶ ${songId}`, tags || '(无标签)');
  songTagCache.set(key, tags);
  return tags;
}

// ── 选歌接口封装（每个对应一个网易云原接口，工具层按原接口名暴露）──────────────
const pickSong = (x: any) => x?.songInfo || x?.song || x; // 不同接口把歌包在不同字段里

// cloudsearch type=100 搜歌手 → [{id,name}]
export async function searchArtists(
  keyword: string,
  limit = 12,
  cookie?: string,
): Promise<{ id: number; name: string }[]> {
  await initNeteaseConfig();
  try {
    const r = await api.cloudsearch({ keywords: keyword, type: 100, limit, cookie });
    const arts = (r.body?.result?.artists || []).map((a: any) => ({ id: a.id, name: a.name }));
    log.info(`cloudsearch(歌手) ▶ ${arts.length} for "${keyword}"`, arts.slice(0, 10));
    return arts;
  } catch (err: any) {
    log.warn(`cloudsearch(歌手) failed "${keyword}"`, { error: err.message });
    return [];
  }
}

// cloudsearch type=1000 搜歌单 → [{id,name,trackCount}]
export interface PlaylistHit {
  id: number;
  name: string;
  trackCount: number;
  playCount: number; // 播放量——挑「好歌单」最关键的质量信号
  creator: string; // 歌单作者昵称
  description: string; // 歌单简介（截断），帮判断主题贴不贴
}
export async function searchPlaylists(
  keyword: string,
  limit = 12,
  cookie?: string,
): Promise<PlaylistHit[]> {
  await initNeteaseConfig();
  try {
    const r = await api.cloudsearch({ keywords: keyword, type: 1000, limit, cookie });
    const pls: PlaylistHit[] = (r.body?.result?.playlists || []).map((p: any) => ({
      id: p.id,
      name: p.name,
      trackCount: p.trackCount,
      playCount: p.playCount ?? 0,
      creator: p.creator?.nickname || '',
      description: (p.description || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    }));
    log.info(
      `cloudsearch(歌单) ▶ ${pls.length} for "${keyword}"`,
      pls.slice(0, 10).map((p) => ({ id: p.id, name: p.name, playCount: p.playCount })),
    );
    return pls;
  } catch (err: any) {
    log.warn(`cloudsearch(歌单) failed "${keyword}"`, { error: err.message });
    return [];
  }
}

// playmode_intelligence_list 心动模式：种子歌(+所在歌单)→ 智能相似歌
export async function getIntelligenceList(
  songId: number,
  playlistId: number | undefined,
  count: number,
  cookie?: string,
): Promise<RawSong[]> {
  await initNeteaseConfig();
  log.info(`playmode_intelligence_list ◀ input`, { songId, playlistId, count, cookie: ck(cookie) });
  try {
    const r = await api.playmode_intelligence_list({
      id: songId,
      pid: playlistId ?? songId,
      sid: songId,
      count,
      cookie,
    });
    const songs = (r.body?.data || [])
      .map((x: any) => mapSong(pickSong(x)))
      .filter((s: RawSong) => s.id);
    log.info(`playmode_intelligence_list ▶ ${songs.length} songs`, songPreview(songs));
    return songs;
  } catch (err: any) {
    log.warn(`playmode_intelligence_list failed`, { error: err.message });
    return [];
  }
}

// personal_fm 私人FM：无限个性化单曲流（一次返回数首）
export async function getPersonalFm(cookie?: string): Promise<RawSong[]> {
  await initNeteaseConfig();
  log.info(`personal_fm ◀ input`, { cookie: ck(cookie) });
  try {
    const r = await api.personal_fm({ cookie });
    const songs = (r.body?.data || [])
      .map((x: any) => mapSong(pickSong(x)))
      .filter((s: RawSong) => s.id);
    log.info(`personal_fm ▶ ${songs.length} songs`, songPreview(songs));
    return songs;
  } catch (err: any) {
    log.warn(`personal_fm failed`, { error: err.message });
    return [];
  }
}

// style_list 曲风标签表 → [{tagId,name}]（给 style_song 用）
export async function getStyleList(cookie?: string): Promise<{ tagId: number; name: string }[]> {
  await initNeteaseConfig();
  try {
    const r = await api.style_list({ cookie });
    const flat: { tagId: number; name: string }[] = [];
    const walk = (arr: any[]) =>
      (arr || []).forEach((t: any) => {
        if (t?.tagId) flat.push({ tagId: t.tagId, name: t.tagName || t.name });
        if (Array.isArray(t?.tags)) walk(t.tags);
      });
    walk(r.body?.data || []);
    log.info(`style_list ▶ ${flat.length} style tags`, flat.slice(0, 20));
    return flat;
  } catch (err: any) {
    log.warn(`style_list failed`, { error: err.message });
    return [];
  }
}

// style_song 按曲风标签出歌
export async function getStyleSongs(
  tagId: number,
  size: number,
  cookie?: string,
): Promise<RawSong[]> {
  await initNeteaseConfig();
  log.info(`style_song ◀ input`, { tagId, size, cookie: ck(cookie) });
  try {
    const r = await api.style_song({ tagId, size, cookie });
    const list = r.body?.data?.songs || r.body?.data?.list || r.body?.data || [];
    const songs = (Array.isArray(list) ? list : [])
      .map((x: any) => mapSong(pickSong(x)))
      .filter((s: RawSong) => s.id);
    log.info(`style_song ▶ ${songs.length} songs (tagId=${tagId})`, songPreview(songs));
    return songs;
  } catch (err: any) {
    log.warn(`style_song failed (tagId=${tagId})`, { error: err.message });
    return [];
  }
}

// user_playlist 用户的歌单列表（含「我喜欢的音乐」红心歌单；mine=是否自建）
export async function getUserPlaylists(
  userId: number,
  cookie?: string,
): Promise<{ id: number; name: string; trackCount: number; mine: boolean }[]> {
  log.info(`user_playlist ◀ input`, { uid: userId, cookie: ck(cookie) });
  try {
    const r = await api.user_playlist({ uid: userId, limit: 50, cookie });
    const pls = (r.body?.playlist || []).map((p: any) => ({
      id: p.id,
      name: p.name,
      trackCount: p.trackCount,
      mine: p.creator?.userId === userId || p.userId === userId,
    }));
    log.info(`user_playlist ▶ ${pls.length} playlists`, pls.slice(0, 15));
    return pls;
  } catch (err: any) {
    log.warn(`user_playlist failed`, { error: err.message });
    return [];
  }
}

// simi_artist 相似歌手 → [{id,name}]（再喂 artist_top_song）
export async function getSimilarArtists(
  artistId: number,
  cookie?: string,
): Promise<{ id: number; name: string }[]> {
  await initNeteaseConfig();
  try {
    const r = await api.simi_artist({ id: artistId, cookie });
    const arts = (r.body?.artists || []).map((a: any) => ({ id: a.id, name: a.name }));
    log.info(`simi_artist ▶ ${arts.length} for ${artistId}`, arts.slice(0, 10));
    return arts;
  } catch (err: any) {
    log.warn(`simi_artist failed (${artistId})`, { error: err.message });
    return [];
  }
}

// playlist_track_all 拉某个歌单的全部曲目
export async function getPlaylistSongs(
  playlistId: number,
  limit: number,
  cookie?: string,
): Promise<RawSong[]> {
  log.info(`playlist_track_all ◀ input`, { playlistId, limit, cookie: ck(cookie) });
  try {
    const r = await api.playlist_track_all({ id: playlistId, limit, cookie });
    const songs = (r.body?.songs || []).map(mapSong).filter((s: RawSong) => s.id);
    log.info(
      `playlist_track_all ▶ ${songs.length} songs (playlist=${playlistId})`,
      songPreview(songs),
    );
    return songs;
  } catch (err: any) {
    log.warn(`playlist_track_all failed (${playlistId})`, { error: err.message });
    return [];
  }
}

export async function getStylePreference(cookie?: string): Promise<any> {
  log.info(`style_preference ◀ input`, { cookie: ck(cookie) });
  try {
    const res = await api.style_preference({ cookie });
    log.info(`style_preference ▶ output`, res.body?.data || res.body || null);
    return res.body || null;
  } catch (err: any) {
    log.warn('style_preference failed', { error: err.message });
    return null;
  }
}

// ── 音乐知识接口封装（答问用，不为建单服务）─────────────────────────────────
// 歌词：返回纯歌词文本（去掉时间轴），认不出/无歌词时返回空串。
export async function getLyric(songId: number | string, cookie?: string): Promise<string> {
  await initNeteaseConfig();
  const id = Number(String(songId).replace(/^netease-/, ''));
  log.info(`lyric ◀ input`, { songId: id, cookie: ck(cookie) });
  try {
    const r = await api.lyric({ id, cookie });
    const raw: string = r.body?.lrc?.lyric || '';
    // 去掉 [mm:ss.xx] 时间轴，留下可读歌词。
    const text = raw
      .replace(/\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/g, '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join('\n');
    log.info(`lyric ▶ output (${text.length} chars)`, text.slice(0, 80));
    return text;
  } catch (err: any) {
    log.warn(`lyric failed for ${id}`, { error: err.message });
    return '';
  }
}

// 歌手专辑列表：给歌手 id，返回其专辑（id+名+年）。
export async function getArtistAlbums(
  artistId: number,
  limit = 30,
  cookie?: string,
): Promise<{ id: number; name: string; year: number | null; size: number }[]> {
  await initNeteaseConfig();
  log.info(`artist_album ◀ input`, { artistId, limit, cookie: ck(cookie) });
  try {
    const r = await api.artist_album({ id: artistId, limit, cookie });
    const albums = (r.body?.hotAlbums || []).map((a: any) => ({
      id: a.id,
      name: a.name,
      year: a.publishTime ? new Date(a.publishTime).getFullYear() : null,
      size: a.size ?? 0,
    }));
    log.info(`artist_album ▶ ${albums.length} albums (artist=${artistId})`, albums.slice(0, 10));
    return albums;
  } catch (err: any) {
    log.warn(`artist_album failed (${artistId})`, { error: err.message });
    return [];
  }
}

// 专辑曲目：给【专辑 id】（≠ 歌单 id，来自 artist_album 或搜索结果的 al.id），返回这张专辑的歌。
// 用 album 接口（body.songs），别用 playlist_track_all——专辑 id 和歌单 id 是两个命名空间。
export async function getAlbumSongs(albumId: number, cookie?: string): Promise<RawSong[]> {
  await initNeteaseConfig();
  log.info(`album ◀ input`, { albumId, cookie: ck(cookie) });
  try {
    const r = await api.album({ id: albumId, cookie });
    const songs = (r.body?.songs || []).map(mapSong).filter((s: RawSong) => s.id);
    log.info(
      `album ▶ ${songs.length} songs (album=${albumId}, "${r.body?.album?.name || ''}")`,
      songPreview(songs),
    );
    return songs;
  } catch (err: any) {
    log.warn(`album failed (${albumId})`, { error: err.message });
    return [];
  }
}

export { api as rawApi };
