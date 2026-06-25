// 播放器控制工具集 (Player tools) — 控制网页播放器客户端。每个工具的副作用都「搭车」在它的
// on_tool_end JSON 输出上（带 `op` 字段）：服务端把事件原样 SSE 透传，网页客户端读到后驱动 <audio>。
// 因此这些工具必须挂在【顶层 agent】（子 agent 内的事件不会冒泡给客户端）。
//   - 队列：commit_queue（建/加单）、queue_remove、queue_clear
//   - 播放：player_play/pause/resume/skip/stop、player_seek、player_volume、player_play_index
//   - 模式：narration_mode（逐曲解说/串词开关；私人 FM 单曲流是 musicTools 里的 personal_fm，两者不同）
//   - 读取：get_player_state
import { DynamicTool, DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { AgentDeps, traced, PlayerOp } from './agentRuntime';
import { Track, checkPlayableIds, getPlaylistSongs } from './netease';
import { toTrack } from './musicTools';
import { makeLogger } from './logger';

const log = makeLogger('ModuleB:PlayerTools');

export function buildPlayerTools(deps: AgentDeps) {
  const { session } = deps;

  // ── commit_queue ──（把挑好的歌 id 落成播放队列；id 必须是找歌工具真实返回过的）
  const commit_queue = new DynamicStructuredTool({
    name: 'commit_queue',
    description:
      '【选歌的终点·把挑好的歌落成实际播放队列】凑够约 12 首再调一次，别反复 commit。mode=set：整体替换歌单并自动开始播放（建新单用）。mode=add：把新歌接到当前正在播放的歌之后、不打断当前歌（「再加几首」用）。songIds 只能用找歌工具真实返回过的 id，绝不能自己编。',
    schema: z.object({
      songIds: z.array(z.string()).describe('最终选中的歌 id，按播放顺序'),
      theme: z.string().describe('一句话主题，如「专注写代码」'),
      mode: z
        .enum(['set', 'add'])
        .describe('set=换歌单开播；add=接到当前正在播放的歌之后、不打断当前歌'),
    }),
    func: traced(
      'commit_queue',
      async ({
        songIds,
        theme,
        mode,
      }: {
        songIds: string[];
        theme: string;
        mode: 'set' | 'add';
      }) => {
        const tracks: Track[] = [];
        const seen = new Set<string>();
        const unknown: string[] = [];
        for (const raw of songIds) {
          const id = raw.startsWith('netease-') ? raw : `netease-${raw}`;
          if (seen.has(id)) continue;
          const cand = session.candidates.get(id);
          if (!cand) {
            unknown.push(raw);
            continue;
          }
          seen.add(id);
          tracks.push(toTrack(cand.song, cand.source));
        }
        if (tracks.length === 0) {
          return '这些 id 都不是找歌工具返回过的（不能凭空编 id）。先用找歌工具找到真实候选，再用它们的 id 提交。';
        }
        // Playability gate: drop tracks this user can't actually play (VIP-only / no copyright / pulled,
        // and most翻唱 covers with dead sources) BEFORE they reach the queue — otherwise the client
        // stutters or auto-skips on a dead first track. Verified via song_url_v1 with the user's cookie;
        // fails open. Keep order; if every track checks out, nothing changes.
        let unplayable: Track[] = [];
        const playable = await checkPlayableIds(
          tracks.map((t) => t.id),
          deps.cookie,
        );
        if (playable.size > 0 && playable.size < tracks.length) {
          unplayable = tracks.filter((t) => !playable.has(t.id));
          const kept = tracks.filter((t) => playable.has(t.id));
          tracks.length = 0;
          tracks.push(...kept);
        }
        session.queueOp = mode;
        session.queue = tracks;
        session.narration = [];
        if (mode === 'set') {
          session.autoplay = true;
          session.playerOp = 'play';
        }
        log.info(`commit_queue ▶ ${mode} ${tracks.length} songs`, {
          theme,
          unknown: unknown.length,
          unplayable: unplayable.length,
        });
        // The queue (a side effect) rides this tool output: the client reads it off on_tool_end and
        // drives the player. `note` is for the model; `queue` is for the client.
        const base = `${mode === 'set' ? '已建好歌单并开播' : '已在队列最前加入'}：${tracks.length} 首，主题「${theme}」`;
        // Tell the model what got dropped so it can backfill (search a real, playable version — often the
        // dropped one was a 翻唱/无版权 substitute, not the original the user asked for) with mode:"add".
        const dropNote = unplayable.length
          ? `。已剔除 ${unplayable.length} 首放不出来的（${unplayable.map((t) => `${t.title}—${t.artist}`).join('、')}）——若用户点名要这些，多半是翻唱/无版权版本拿错了，回头找原唱的可播版本再 commit_queue(mode:"add") 补上`
          : '';
        return JSON.stringify({
          op: mode,
          theme,
          count: tracks.length,
          note: base + dropNote,
          queue: tracks,
        });
      },
    ),
  });

  // ── play_playlist ──（整张歌单直接入队播放，免去 playlist_track_all + 自己挑 id 的两步）
  const play_playlist = new DynamicStructuredTool({
    name: 'play_playlist',
    description:
      '【整张歌单一键入队播放】给一个【歌单 id】，把这个歌单里的歌【一次性全部】放进播放队列并开播——不用先 playlist_track_all 拉歌、也不用自己挑 id。这是「放整张歌单」的标准做法，比 commit_queue 自己选 6~12 首更忠实于歌单原貌。歌单 id 来源：user_playlist（用户的红心/自建单）、search_playlist（搜到的主题单）。mode=set：整张替换当前队列并开播（默认；「放我的红心 / 放这个歌单 / 听某某歌单」）；mode=add：接到当前队列后面。limit 控制最多取多少首（默认 100，覆盖一般个人歌单；歌单特别大时可调高）。注意：歌单 id ≠ 专辑 id（专辑用 album）。',
    schema: z.object({
      id: z.string().describe('歌单 id（来自 user_playlist 或 search_playlist）'),
      mode: z
        .enum(['set', 'add'])
        .optional()
        .describe('set=整张替换并开播(默认)；add=接到队列后面'),
      limit: z.number().optional().describe('最多取多少首，默认 100'),
    }),
    func: traced(
      'play_playlist',
      async ({ id, mode, limit }: { id: string; mode?: 'set' | 'add'; limit?: number }) => {
        const pid = Number(String(id).replace(/^netease-/, ''));
        if (!pid) return '歌单 id 不合法。';
        const m = mode || 'set';
        const raw = await getPlaylistSongs(pid, limit || 100, deps.cookie);
        if (raw.length === 0)
          return '这个歌单没拉到歌（可能是私密歌单，或这是专辑 id / 歌手 id 拿错了）。';
        let tracks: Track[] = raw.map((s) => toTrack(s, 'library'));
        // Same playability gate as commit_queue: drop VIP-only / no-copyright / dead tracks before they
        // reach the queue so the client doesn't stutter or auto-skip. One batched call; fails open.
        let unplayable = 0;
        const playable = await checkPlayableIds(
          tracks.map((t) => t.id),
          deps.cookie,
        );
        if (playable.size > 0 && playable.size < tracks.length) {
          const kept = tracks.filter((t) => playable.has(t.id));
          unplayable = tracks.length - kept.length;
          tracks = kept;
        }
        session.queueOp = m;
        session.queue = tracks;
        session.narration = [];
        if (m === 'set') {
          session.autoplay = true;
          session.playerOp = 'play';
        }
        log.info(`play_playlist ▶ ${m} ${tracks.length} songs (playlist=${pid})`, { unplayable });
        const note = `${m === 'set' ? '已把整张歌单放上并开播' : '已把整张歌单接到当前队列后面'}：${tracks.length} 首${unplayable ? `（剔除 ${unplayable} 首放不出来的）` : ''}`;
        // queue rides this output to the client (same shape commit_queue uses), so the player swaps in
        // the whole playlist and the "play this playlist" bubble button works too.
        return JSON.stringify({ op: m, theme: '歌单', count: tracks.length, note, queue: tracks });
      },
    ),
  });

  const queue_remove = new DynamicStructuredTool({
    name: 'queue_remove',
    description:
      "【从队列删歌】按歌 id 把歌从当前播放队列移除，如 ['netease-123','netease-456']。场景：用户说「把某首/这几首删了 / 不想听这个」。删之前可先 get_player_state 看清队列里有哪些。",
    schema: z.object({
      ids: z.array(z.string()).describe("song ids to remove, e.g. ['netease-123']"),
    }),
    func: traced('queue_remove', async ({ ids }: { ids: string[] }) => {
      const clean = (ids || []).map((s) => s.trim()).filter(Boolean);
      session.queueOp = 'remove';
      session.removedIds = clean;
      return JSON.stringify({ op: 'remove', removedIds: clean });
    }),
  });

  const queue_clear = new DynamicTool({
    name: 'queue_clear',
    description:
      '【清空队列·只在用户要「空着别放」时用】清掉整个播放队列并停止播放。无参数。⚠️建新歌单【绝不要】先调本工具——`commit_queue(mode:"set")` 本身就会整体替换旧队列并自动开播，先 clear 只会让歌立刻停下、在你还在搜歌的这段时间里冷场（dead air）。本工具仅用于用户明确要【清空但先不放新的】：「全清了别放了 / 把单清空 / 这单不要了停一下」。要换一批歌就直接搜 →`commit_queue(set)`，跳过 clear。',
    func: traced('queue_clear', async () => {
      session.queueOp = 'clear';
      session.queue = [];
      return JSON.stringify({ op: 'clear' });
    }),
  });

  const get_player_state = new DynamicTool({
    name: 'get_player_state',
    description:
      '【读当前播放状态】返回最新状态（播放/暂停、当前队列、播到第几首、personalFm 私人 FM 是否开着、narration 串词是否开着）。**通常不必调**——每轮 [context] 已含「私人FM/串词/播放状态/当前曲」的实时快照，照它判断即可，别为确认 FM/串词开没开而多调一轮。只有当你需要看【完整队列逐首明细】（按 id 删歌、跳到第 N 首前核对顺序）时才调它。无参数。',
    func: traced('get_player_state', async () => JSON.stringify(deps.getPlayerState())),
  });

  const makePlayerTool = (op: PlayerOp, desc: string) =>
    new DynamicTool({
      name: `player_${op}`,
      description: `${desc} 仅在用户明确要求时调用。无需参数。`,
      func: traced(`player_${op}`, async () => {
        session.playerOp = op;
        return JSON.stringify({ op: 'player', playerOp: op });
      }),
    });

  // ── player_seek ──（跳到指定秒数）
  const player_seek = new DynamicStructuredTool({
    name: 'player_seek',
    description:
      '【跳进度】把【当前这首歌】的播放进度跳到指定秒数。仅在用户明确要求时（如「跳到 1 分 30 秒」→ 90、「从头放」→ 0）。',
    schema: z.object({ seconds: z.number().describe('position in seconds from the song start') }),
    func: traced('player_seek', async ({ seconds }: { seconds: number }) => {
      const s = Math.max(0, seconds);
      session.seekTo = s;
      return JSON.stringify({ op: 'seek', seconds: s });
    }),
  });

  // ── player_volume ──（设音量 / 静音）
  const player_volume = new DynamicStructuredTool({
    name: 'player_volume',
    description:
      '【音量·静音】设置播放音量（0~1）和/或静音。仅在用户明确要求时（「小声点」降音量、「大声点」升、「静音」muted=true、「取消静音」muted=false）。',
    schema: z.object({
      volume: z.number().optional().describe('0 (silent) .. 1 (max)'),
      muted: z.boolean().optional().describe('true to mute, false to unmute'),
    }),
    func: traced(
      'player_volume',
      async ({ volume, muted }: { volume?: number; muted?: boolean }) => {
        const out: any = { op: 'volume' };
        if (typeof volume === 'number') {
          const v = Math.min(1, Math.max(0, volume));
          session.volume = v;
          out.volume = v;
        }
        if (typeof muted === 'boolean') {
          session.muted = muted;
          out.muted = muted;
        }
        return JSON.stringify(out);
      },
    ),
  });

  // ── player_play_index ──（跳到队列第 N 首，0 基）
  const player_play_index = new DynamicStructuredTool({
    name: 'player_play_index',
    description:
      '【跳到队列第 N 首】跳到并播放【当前队列】里第 N 首（0 基索引）。每轮 [context] 快照里的「当前队列（0 基索引）」就是真实的当前歌单——直接按它数位置，别凭记忆里早先建过的单来数（用户可能已在 UI 改过队列）；队列被截断（很长）时才用 get_player_state 看精确位置。仅在用户明确要求时（如「播放第 3 首」→ index 2、「放第一首」→ 0）。',
    schema: z.object({ index: z.number().describe('zero-based position in the queue') }),
    func: traced('player_play_index', async ({ index }: { index: number }) => {
      const i = Math.max(0, Math.floor(index));
      session.playIndex = i;
      // Resolve the index to the actual song RIGHT NOW (against the same queue the agent reasoned over)
      // and carry its id, so the client jumps to THAT song by identity — not by a bare position that
      // can land on a different track when its local queue has drifted (dedup on add, reorder, etc.).
      const ps = deps.getPlayerState?.();
      const q = ps?.queue ?? [];
      const track = q.length ? q[Math.min(i, q.length - 1)] : undefined;
      return JSON.stringify({ op: 'play_index', index: i, id: track?.id, title: track?.title });
    }),
  });

  // ── narration_mode ──（逐曲解说 / 串词开关）
  // 注意：这【不是】私人 FM。私人 FM（无限单曲流）是 personal_fm 工具。这里只管「每首歌开头有没有口播报幕」。
  // 历史上叫过 fm_mode，但那个名字会和 personal_fm 撞车、让模型分不清，故改名；op 仍是 "fm" 保持客户端兼容。
  const narration_mode = new DynamicStructuredTool({
    name: 'narration_mode',
    description:
      '【逐曲解说·串词开关，不是私人FM】开关「每首歌开头的口播报幕」。开启后每首歌开始时有一段 DJ 解说盖在音乐上。这只是个解说开关，【不挑歌、不动队列、跟私人FM单曲流是两回事】——用户要「无限随便放/一直放别停」是 personal_fm，不是这个。**关串词是个谨慎动作，默认别关、保持原样。** 只在三种情况 on=false：(a) 用户明确说「别报幕/安静/别说话/别打断」；(b) 明确在建【学习/专注/复习/写代码/工作】这类要专注的歌单；(c) 明确的【睡眠/冥想/纯音乐当背景】。除此之外——尤其「放某歌手/放某首歌/放某张专辑/一般歌单」这种普通听歌不是专注场景——一律别动串词；**拿不准算不算专注场景就别关。** on=true：用户明确要「电台解说/报幕/串词」，或建【电台/陪聊/像 DJ 一样】这类要陪伴感的场景。用户明确意愿盖过一切（说了「学习也要报幕」就 on）。串词当前开没开，看每轮 [context] 快照里的 `串词=开着/关着`，不必 get_player_state；已经是目标状态就别再调、也别声称已改。',
    schema: z.object({ on: z.boolean().describe('true to enable narration, false to disable') }),
    func: traced('narration_mode', async ({ on }: { on: boolean }) => {
      session.fmMode = on;
      return JSON.stringify({ op: 'fm', on });
    }),
  });

  return [
    commit_queue,
    play_playlist,
    queue_remove,
    queue_clear,
    get_player_state,
    makePlayerTool('play', '【开始播放】开始播放当前队列。'),
    makePlayerTool('pause', '【暂停】暂停当前播放。'),
    makePlayerTool('resume', '【继续】从暂停处继续播放。'),
    makePlayerTool('skip', '【下一首】跳到队列里的下一首。'),
    makePlayerTool('stop', '【停止】停止播放。'),
    player_seek,
    player_volume,
    player_play_index,
    narration_mode,
  ];
}
