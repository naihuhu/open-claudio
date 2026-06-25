// 音乐能力工具集 (Music tools) — 网易云音乐 API 的【薄封装】，工具名 = 接口名，暴露接口原生参数，
// 不替模型预设用法。两类：
//   1) 找歌工具（cloudsearch / style_song / artist_top_song …）——给「建歌单」备料，把候选 stash 进
//      session，commit 只能用真实出现过的 id（防编造）。
//   2) 知识工具（song_detail / lyric / artist_album / song_tags）——回答音乐问题用，只读、不入队。
// 播放器副作用（commit_queue / 队列增删 / 播放控制）不在这里，见 playerTools.ts。
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import {
  searchSongs,
  searchArtists,
  searchPlaylists,
  getSimilarSongs,
  getSimilarArtists,
  getIntelligenceList,
  getStyleList,
  getStyleSongs,
  getRecommendedSongs,
  getArtistTopSongs,
  getUserPlaylists,
  getPlaylistSongs,
  getSongDetails,
  getSongTags,
  getLyric,
  getArtistAlbums,
  getAlbumSongs,
  RawSong,
  Track,
} from './netease';
import { AgentDeps, RadioSession, traced } from './agentRuntime';
import { makeLogger } from './logger';

const log = makeLogger('ModuleB:MusicTools');

export function toTrack(s: RawSong, source: Track['source']): Track {
  return {
    id: `netease-${s.id}`,
    songId: s.id,
    title: s.name,
    artist: s.artist,
    album: s.album,
    duration: s.duration,
    year: s.year ?? null,
    url: `/api/stream?id=${s.id}`, // 后端流代理每次现解析播放地址
    source,
    reason: '',
    story: '',
  };
}

// Safety net: if the agent searched (candidates surfaced) but never called commit_queue — e.g. it
// looped to the recursion limit — commit the songs it already found so a real result isn't dropped.
// Still the AI's own candidates, but before taking them we (1) drop duplicate titles (same name+
// artist, e.g. the many album/Live copies of one song a bad search returns) and (2) round-robin
// across artists, so a single dominant-artist search doesn't fall back to 8 songs by one person.
export function salvageCommit(session: RadioSession, count = 8): number {
  if ((session.queueOp && session.queue.length) || session.candidates.size === 0) return 0;

  // 1) de-dupe by normalized title|artist (keep first surfaced)
  const seen = new Set<string>();
  const uniq: { song: RawSong; source: Track['source'] }[] = [];
  for (const c of session.candidates.values()) {
    const key = `${c.song.name}|${c.song.artist}`.toLowerCase().replace(/\s+/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(c);
  }

  // 2) bucket by artist, then round-robin so no single artist dominates the fallback
  const buckets = new Map<string, typeof uniq>();
  for (const c of uniq) {
    const a = (c.song.artist || '?').toLowerCase();
    (buckets.get(a) ?? buckets.set(a, []).get(a)!).push(c);
  }
  const picked: typeof uniq = [];
  let progressed = true;
  while (picked.length < count && progressed) {
    progressed = false;
    for (const list of buckets.values()) {
      const next = list.shift();
      if (!next) continue;
      picked.push(next);
      progressed = true;
      if (picked.length >= count) break;
    }
  }

  session.queue = picked.map((c) => toTrack(c.song, c.source));
  session.queueOp = 'set';
  session.narration = [];
  session.autoplay = true;
  session.playerOp = 'play';
  log.warn(
    `salvageCommit: agent never committed → ${session.queue.length} songs (deduped + artist-balanced) from ${session.candidates.size} surfaced candidates`,
  );
  return session.queue.length;
}

export function buildMusicTools(deps: AgentDeps) {
  const { session } = deps;

  // 每个返回歌的工具把候选 stash 进 session：commit 只能挑真实出现过的 id，且 id→歌 直接取回不再请求。
  const stash = (songs: RawSong[], source: Track['source']): RawSong[] => {
    for (const s of songs) {
      const id = `netease-${s.id}`;
      session.searchedIds.add(id);
      if (!session.candidates.has(id)) session.candidates.set(id, { song: s, source });
    }
    return songs;
  };
  const songList = (songs: RawSong[]) =>
    songs.length
      ? JSON.stringify(
          songs.map((s) => ({
            id: `netease-${s.id}`,
            name: s.name,
            artist: s.artist,
            album: s.album,
          })),
        )
      : '没有结果。';

  // ── cloudsearch ──（type: 1 单曲 / 100 歌手 / 1000 歌单，对应网易云原 type 码）
  const cloudsearch = new DynamicStructuredTool({
    name: 'cloudsearch',
    description:
      '【最万能的搜索入口，拿不准时的默认选择】网易云搜索，字面匹配。type=1 单曲（默认）：关键词最好是**具体歌名或歌手名**，或 city pop / lo-fi 这类有对应曲库的风格标签词。注意：「夏天 / 失恋 / 毕业」这类主题概念词不要直接搜——会撞到名字里恰好带这些字的口水歌；先自己想出符合主题的真实歌名/歌手再来搜。type=100：搜歌手，返回 artistId（再喂 artist_top_song 出代表作 / artist_album 列专辑 / simi_artist 找相似歌手）。type=1000：搜歌单（但**搜歌单优先用 search_playlist**，它额外给播放量/作者/简介，更好挑）。场景：用户点名某首歌、某歌手时首选。',
    schema: z.object({
      keywords: z.string().describe('搜索词'),
      type: z.number().optional().describe('1单曲(默认) 100歌手 1000歌单'),
      limit: z.number().optional().describe('条数，默认 30'),
    }),
    func: traced(
      'cloudsearch',
      async ({ keywords, type, limit }: { keywords: string; type?: number; limit?: number }) => {
        const n = limit || 30;
        if (type === 100) {
          const a = await searchArtists(keywords, n, deps.cookie);
          return a.length
            ? JSON.stringify(a.map((x) => ({ artistId: x.id, name: x.name })))
            : '没搜到歌手。';
        }
        if (type === 1000) {
          // 搜歌单优先用专门的 search_playlist（信息更全：播放量/作者/简介）；这里保留兼容。
          const p = await searchPlaylists(keywords, n, deps.cookie);
          return p.length
            ? JSON.stringify(
                p.map((x) => ({
                  playlistId: x.id,
                  name: x.name,
                  trackCount: x.trackCount,
                  playCount: x.playCount,
                })),
              )
            : '没搜到歌单。';
        }
        return songList(stash(await searchSongs(keywords, n, deps.cookie), 'taste'));
      },
    ),
  });

  // ── simi_song ──
  const simi_song = new DynamicStructuredTool({
    name: 'simi_song',
    description:
      '【相似歌扩散】给一首具体的种子歌 id，返回曲风/气质相近的歌。场景：用户喜欢某一首歌、想「多来点这种感觉的 / 像这首一样的」。比 playmode_intelligence_list 更轻量；若要以一首歌为核心铺满整单，用 playmode_intelligence_list。',
    schema: z.object({ id: z.string().describe('歌曲 id，如 netease-12345 或 12345') }),
    func: traced('simi_song', async ({ id }: { id: string }) => {
      const n = Number(String(id).replace(/^netease-/, ''));
      return n ? songList(stash(await getSimilarSongs(n, deps.cookie), 'explore')) : 'id 不合法。';
    }),
  });

  // ── simi_artist ──（返回相似歌手 id，再喂 artist_top_song）
  const simi_artist = new DynamicStructuredTool({
    name: 'simi_artist',
    description:
      '【找相似歌手】给一个歌手 id，返回风格相近的歌手（id+名字）——它只给歌手、不给歌，要再用 artist_top_song 把这些歌手的代表作取出来。场景：用户喜欢某歌手、想听「类似 XX 的别的歌手 / 这种风格的人」。',
    schema: z.object({ id: z.number().describe('歌手 id') }),
    func: traced('simi_artist', async ({ id }: { id: number }) => {
      const a = await getSimilarArtists(id, deps.cookie);
      return a.length
        ? JSON.stringify(a.map((x) => ({ artistId: x.id, name: x.name })))
        : '没有相似歌手。';
    }),
  });

  // ── playmode_intelligence_list ──（心动模式）
  const playmode_intelligence_list = new DynamicStructuredTool({
    name: 'playmode_intelligence_list',
    description:
      '【心动模式·围绕一首歌成单】给种子歌 id（和它所在歌单 pid，可省略），平台智能生成一整串相似歌。比 simi_song 更「成单」。场景：用户说「就照着这首的感觉给我铺一整单」。',
    schema: z.object({
      id: z.string().describe('种子歌曲 id'),
      pid: z.number().optional().describe('种子歌所在歌单 id，可省略'),
      count: z.number().optional().describe('数量，默认 12'),
    }),
    func: traced(
      'playmode_intelligence_list',
      async ({ id, pid, count }: { id: string; pid?: number; count?: number }) => {
        const n = Number(String(id).replace(/^netease-/, ''));
        return n
          ? songList(stash(await getIntelligenceList(n, pid, count || 12, deps.cookie), 'explore'))
          : 'id 不合法。';
      },
    ),
  });

  // ── style_list ──（曲风标签表 → tagId）
  const style_list = new DynamicStructuredTool({
    name: 'style_list',
    description:
      '【曲风表·查 tagId】返回网易云所有曲风/流派标签的 tagId+名字（爵士、citypop、后摇、shoegaze、lo-fi、国风…）。无参数。它本身不出歌，是 style_song 的前置：先在这里找到目标曲风的 tagId，再用 style_song 出歌。',
    schema: z.object({}),
    func: traced('style_list', async () => {
      const tags = await getStyleList(deps.cookie);
      return tags.length
        ? JSON.stringify(tags.map((t) => ({ tagId: t.tagId, name: t.name })))
        : '曲风表为空。';
    }),
  });

  // ── style_song ──（按曲风 tagId 出歌）
  const style_song = new DynamicStructuredTool({
    name: 'style_song',
    description:
      '【按曲风出歌】给曲风 tagId（先用 style_list 查到），返回该曲风下的歌。场景：用户点名的是一种「曲风/流派」而不是具体歌手或歌曲（如「来点 citypop」「放点后摇」）。流程：style_list 查 tagId → style_song。',
    schema: z.object({
      tagId: z.number().describe('曲风 tagId，来自 style_list'),
      size: z.number().optional().describe('条数，默认 20'),
    }),
    func: traced('style_song', async ({ tagId, size }: { tagId: number; size?: number }) =>
      songList(stash(await getStyleSongs(tagId, size || 20, deps.cookie), 'taste')),
    ),
  });

  // ── recommend_songs ──（每日推荐）
  const recommend_songs = new DynamicStructuredTool({
    name: 'recommend_songs',
    description:
      '【每日个性化推荐·懂你的随便听】返回平台基于这位登录用户长期口味算出的每日推荐歌。无参数（需用户已登录）。场景：用户说「随便听点 / 今天听啥 / 给我推荐 / 来点我可能喜欢的」——不点名、但想听合自己口味的歌时，这是首选。',
    schema: z.object({}),
    func: traced('recommend_songs', async () =>
      songList(stash(await getRecommendedSongs(deps.cookie), 'taste')),
    ),
  });

  // ── personal_fm ──（私人 FM 开关·控制客户端的单曲流，不入候选池）
  // 不再一次性返回歌灌进队列；改为开/关一个「单曲流」模式：客户端开启后每首播完自动拉下一首，
  // 关闭即停止续流。副作用搭车在 op:"personal_fm" 上由客户端读取。
  const personal_fm = new DynamicStructuredTool({
    name: 'personal_fm',
    description:
      '【私人 FM 开关·无限随便放】开/关私人 FM 单曲流。开启后客户端每首播完自动拉下一首、循环不停，适合「一直放别停 / 当背景音乐 / 通勤睡前随便放着」。场景：用户说「来个私人 FM / 一直放别停」→ action:"start"；说「关掉 FM / 别自动续了」→ action:"stop"。这是一个模式开关，本身不挑歌、不动 commit_queue。注意：用户也能在播放器上自己点按钮开关 FM，所以【别凭记忆断定 FM 是开是关】——每轮 [context] 快照已给出 `私人FM=开着/关着` 的真值，照它判断即可，别再 get_player_state；已经是目标状态就别重复 start/stop。',
    schema: z.object({
      action: z.enum(['start', 'stop']).describe('start=开启私人 FM 单曲流；stop=关闭'),
    }),
    func: traced('personal_fm', async ({ action }: { action: 'start' | 'stop' }) => {
      session.personalFm = action === 'start';
      return JSON.stringify({ op: 'personal_fm', on: session.personalFm });
    }),
  });

  // ── artist_top_song ──（歌手热门歌，需歌手 id）
  const artist_top_song = new DynamicStructuredTool({
    name: 'artist_top_song',
    description:
      '【歌手代表作】给歌手 id（用 cloudsearch type=100 或 simi_artist 拿到），返回这位歌手最热门的歌。场景：用户点名要听某个歌手（「放点周杰伦」）。流程：cloudsearch(type=100) 拿 artistId → artist_top_song。',
    schema: z.object({ id: z.number().describe('歌手 id') }),
    func: traced('artist_top_song', async ({ id }: { id: number }) =>
      songList(stash(await getArtistTopSongs(id, deps.cookie), 'taste')),
    ),
  });

  // ── user_playlist ──（用户歌单列表，含红心；mine=自建）
  const user_playlist = new DynamicStructuredTool({
    name: 'user_playlist',
    description:
      '【用户的歌单列表·含红心】返回登录用户的所有歌单（id+名字+曲目数+mine 是否自建）。第一个通常是「我喜欢的音乐」——也就是用户亲手点❤收藏的【红心歌单】，代表 ta 已经确认喜欢、最安全的一批歌。无参数。它只列歌单、不出歌，要用 playlist_track_all 拉某个歌单里的歌。场景：用户说「放点我喜欢的 / 我收藏的 / 我的红心 / 我歌单里的歌」时，先来这里找到对应歌单。',
    schema: z.object({}),
    func: traced('user_playlist', async () => {
      if (!deps.userId) return '用户未登录。';
      const pls = await getUserPlaylists(deps.userId, deps.cookie);
      return pls.length
        ? JSON.stringify(
            pls.map((p) => ({
              playlistId: p.id,
              name: p.name,
              trackCount: p.trackCount,
              mine: p.mine,
            })),
          )
        : '没有歌单。';
    }),
  });

  // ── search_playlist ──（搜公开主题歌单，返回播放量/作者/简介帮挑好单）
  const search_playlist = new DynamicStructuredTool({
    name: 'search_playlist',
    description:
      '【搜歌单·按主题/场景找现成歌单】给一个主题或场景词（「周末咖啡馆 / 跑步 / 90 年代华语 / city pop / 学习专注」），返回网易云上匹配的公开歌单：playlistId、名字、曲目数、播放量 playCount、作者、简介。场景：用户想【整个现成的歌单】来听，而不是让你一首首挑（「找个 XX 的歌单」「有没有适合 YY 的歌单」「来个歌单」）。挑单要点：**优先播放量高（playCount 大＝大家验证过的好单）**、曲目数适中（别太少也别上千）、名字/简介贴主题、避开像广告/水单的。选定后用 playlist_track_all(playlistId) 取歌 → commit_queue(mode:"set") 开播。',
    schema: z.object({
      keywords: z.string().describe('歌单主题/场景词，如「深夜 citypop」'),
      limit: z.number().optional().describe('返回几个歌单，默认 12'),
    }),
    func: traced(
      'search_playlist',
      async ({ keywords, limit }: { keywords: string; limit?: number }) => {
        const p = await searchPlaylists(keywords, limit || 12, deps.cookie);
        return p.length
          ? JSON.stringify(
              p.map((x) => ({
                playlistId: x.id,
                name: x.name,
                trackCount: x.trackCount,
                playCount: x.playCount,
                creator: x.creator,
                description: x.description,
              })),
            )
          : '没搜到歌单，换个主题词试试。';
      },
    ),
  });

  // ── playlist_track_all ──（拉某歌单的歌；找歌单后用它「展开成歌」再 commit_queue 播放）
  const playlist_track_all = new DynamicStructuredTool({
    name: 'playlist_track_all',
    description:
      '【拉歌单里的歌·播放歌单的第二步】给歌单 id，返回里面的歌（已入候选池，可直接 commit_queue 播放）。id 的三种来源：search_playlist（搜到的公开主题歌单）、user_playlist（用户自己的歌单/红心）、cloudsearch type=1000。场景：用户要听某个具体歌单。**播放整个歌单的标准流程**：search_playlist 或 user_playlist 找到 playlistId → playlist_track_all 取歌 → commit_queue(mode:"set") 开播。歌单很大时用 limit 控制取多少首（默认 30）。',
    schema: z.object({
      id: z.string().describe('歌单 id'),
      limit: z.number().optional().describe('最多取多少首，默认 30'),
    }),
    func: traced('playlist_track_all', async ({ id, limit }: { id: string; limit?: number }) => {
      const n = Number(String(id).replace(/^netease-/, ''));
      return n
        ? songList(stash(await getPlaylistSongs(n, limit || 30, deps.cookie), 'library'))
        : 'id 不合法。';
    }),
  });

  // ── 知识工具（答问用，只读、不入队、不 stash）─────────────────────────────
  // song_detail：给歌曲 id，返回完整信息（歌名/歌手/专辑/年代/时长）。用于回答「这首谁唱的/哪年的」。
  const song_detail = new DynamicStructuredTool({
    name: 'song_detail',
    description:
      '【歌曲详情·答问用，只读不入队】给一个或多个歌曲 id，返回完整信息（歌名/歌手/专辑/年代/时长秒数）。场景：回答「这首谁唱的 / 哪年的 / 哪张专辑 / 多长」。',
    schema: z.object({ ids: z.array(z.string()).describe("歌曲 id 列表，如 ['netease-12345']") }),
    func: traced('song_detail', async ({ ids }: { ids: string[] }) => {
      const nums = (ids || [])
        .map((x) => Number(String(x).replace(/^netease-/, '')))
        .filter(Boolean);
      if (!nums.length) return 'id 不合法。';
      const songs = await getSongDetails(nums, deps.cookie);
      return songs.length
        ? JSON.stringify(
            songs.map((s) => ({
              id: `netease-${s.id}`,
              name: s.name,
              artist: s.artist,
              album: s.album,
              year: s.year ?? null,
              duration: s.duration,
            })),
          )
        : '没查到这些歌。';
    }),
  });

  // lyric：给歌曲 id，返回歌词文本（已去时间轴）。
  const lyric = new DynamicStructuredTool({
    name: 'lyric',
    description:
      '【歌词·答问用，只读不入队】给一首歌 id，返回纯歌词文本（已去掉时间轴），没歌词时返回空。场景：「歌词是什么 / 这首在唱什么 / 讲什么」。',
    schema: z.object({ id: z.string().describe('歌曲 id，如 netease-12345') }),
    func: traced('lyric', async ({ id }: { id: string }) => {
      const text = await getLyric(id, deps.cookie);
      return text || '这首没有可用的歌词。';
    }),
  });

  // artist_album：给歌手 id，返回其专辑列表。
  const artist_album = new DynamicStructuredTool({
    name: 'artist_album',
    description:
      '【歌手专辑列表·答问用，只读不入队】给歌手 id（用 cloudsearch type=100 拿到），返回其专辑列表（id/名/年/曲目数）。场景：「某歌手出过哪些专辑 / 最新专辑是哪张」。',
    schema: z.object({
      id: z.number().describe('歌手 id'),
      limit: z.number().optional().describe('条数，默认 30'),
    }),
    func: traced('artist_album', async ({ id, limit }: { id: number; limit?: number }) => {
      const albums = await getArtistAlbums(id, limit || 30, deps.cookie);
      return albums.length ? JSON.stringify(albums) : '没查到这位歌手的专辑。';
    }),
  });

  // album：给【专辑 id】（≠ 歌单 id）返回这张专辑的歌，可入队。要「听某张专辑」时用它，不是 playlist_track_all。
  const album = new DynamicStructuredTool({
    name: 'album',
    description:
      '【专辑曲目·可入队】给一个【专辑 id】，返回这张专辑的全部歌曲。专辑 id 来自 artist_album 的 id 字段，或 song_detail 里某首歌所属专辑。场景：用户想【听某张专辑】（「放许嵩的安泊猜想」「来整张某专辑」）→ 先拿到专辑 id，再用本工具取歌、commit_queue 播放。注意：专辑 id 和歌单 id 是两套，别把专辑 id 喂给 playlist_track_all（会取到无关内容）。',
    schema: z.object({ id: z.string().describe('专辑 id（来自 artist_album），如 381824526') }),
    func: traced('album', async ({ id }: { id: string }) => {
      const n = Number(String(id).replace(/^netease-/, ''));
      return n ? songList(stash(await getAlbumSongs(n, deps.cookie), 'library')) : 'id 不合法。';
    }),
  });

  // song_tags：给歌曲 id，返回曲风/情绪标签。
  const song_tags = new DynamicStructuredTool({
    name: 'song_tags',
    description:
      '【歌曲曲风/情绪标签·答问或配单用，只读不入队】给一首歌 id，返回它的曲风、情绪等标签。场景：回答「这首什么风格 / 什么情绪」，或你要判断一首歌的气质来给歌单配味时。',
    schema: z.object({ id: z.string().describe('歌曲 id，如 netease-12345') }),
    func: traced('song_tags', async ({ id }: { id: string }) => {
      const tags = await getSongTags(String(id).replace(/^netease-/, ''), deps.cookie);
      return tags || '没有标签信息。';
    }),
  });

  return [
    cloudsearch,
    simi_song,
    simi_artist,
    playmode_intelligence_list,
    style_list,
    style_song,
    recommend_songs,
    personal_fm,
    artist_top_song,
    user_playlist,
    search_playlist,
    playlist_track_all,
    song_detail,
    lyric,
    artist_album,
    album,
    song_tags,
  ];
}
