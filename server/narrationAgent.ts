// 串词生成 (Narration) — SPEC «模块 B：串词生成» / D-19.
// generateSongNarration writes ONE self-contained 串词 for the CURRENT song at PLAY time, using the
// song info (歌名/歌手/曲风) + 队列位置 + 天气/时间. It is called by /api/narration only when FM mode
// is on; the DJ agent no longer produces narration.
import type { Provider } from './ttsAdapter';
import { NarrationItem, extractJson } from './agentRuntime';
import { makeLogger } from './logger';

const log = makeLogger('ModuleB:Narration');

export type { NarrationItem } from './agentRuntime';

// Lightweight song shape for narration (decoupled from the agent — usable by a play-time endpoint).
export interface SongLite {
  id: string;
  title: string;
  artist: string;
  album?: string;
  year?: number | null;
  reason?: string;
  tags?: string; // genre/mood tags (曲风/推荐标签) to anchor the narration's tone
  lyrics?: string; // plain-text lyrics (时间轴已去除) — real grounding so the AI doesn't guess the theme
}

export interface NarrationGenOpts {
  songs: SongLite[];
  userMsg: string; // current chat context (often empty at play time)
  provider: Provider;
  invokeLLM: (system: string, user: string) => Promise<string>;
  cityTimeWeather: string;
  position?: { index: number; total: number }; // 当前歌在队列中的位置（第 index/共 total 首）
}

// 电台 DJ 质感：强制注入每条 instruction，保证整段始终是「深夜电台 DJ、近场麦克风」的口吻，不靠模型自觉。
// 写成豆包 context_texts 认的【自然语言语音指令】口吻（"用…的语气念"，SPEC §7-A），不是干巴巴的形容词堆。
const DJ_TEXTURE = '用电台 DJ 贴近麦克风的温暖、磁性嗓音播报，像电台主持人娓娓道来';

function templateScript(s: SongLite, provider: Provider): NarrationItem['script'] {
  // Doubao 用整段统一的一条语音指令（避免逐句割裂），并带上电台 DJ 质感。
  const tone = `${DJ_TEXTURE}，语速平稳、略带气声`;
  return provider === 'fish'
    ? [`[warm] 这是 ${s.artist} 的《${s.title}》。`, `[calm] 让它陪你一会儿。`]
    : [
        { text: `这是 ${s.artist} 的《${s.title}》。`, instruction: tone },
        { text: '让它陪你一会儿。', instruction: tone },
      ];
}

// Doubao 归一化：整段串词只有【一条】统一语音指令，套到每一句上，得到下游统一的 {text, instruction}[]。
// 不做逐句 instruction——一首歌的串词就是一个整体口吻；并强行前置 DJ 电台质感。
function normalizeDoubaoScript(found: any): NarrationItem['script'] {
  const script = Array.isArray(found?.script) ? found.script : [];
  const tone = (typeof found?.instruction === 'string' && found.instruction.trim()) || '';
  const overall = tone ? `${DJ_TEXTURE}；${tone}` : DJ_TEXTURE;
  return script
    .map((seg: any) => ({
      text: typeof seg === 'string' ? seg : (seg?.text ?? ''),
      instruction: overall,
    }))
    .filter((s: any) => s.text);
}

// 写作要求对两家通用（SPEC §3/§6）；差异只在情感怎么表达。下面两套提示词按 TTS_PROVIDER 二选一。
// cityTimeWeather 现在是【条件下发】：只有整点放歌才传入（见 server /api/narration），其余时刻为空字符串。
function commonWritingRules(cityTimeWeather: string): string {
  const scene = cityTimeWeather.trim();
  const sceneRule = scene
    ? `- 【整点报时·可点场景】：现在正好整点，可以像电台 DJ 整点报时那样，在某一句里自然地把当前时间/地点/天气轻报一句（${scene}）；别生硬罗列、别每句都提，点到为止。`
    : `- 【不提时间/天气/地点】：本次【不提供】任何场景信息，串词里【绝对不要】出现时间、天气、地点；也别用"深夜/夜里/凌晨/睡前"之类时段定调——听歌是 24 小时的事，别擅自假设现在几点。`;
  return `你是音乐助手「Claudio」。为给定歌曲写一段独立的简短介绍/串场，只介绍这首歌，不提其它歌。每段 4~10 句、念 15~45 秒。
- 【先贴合这首歌本身的情绪与曲风】：若下方给了"曲风/标签"，**以它为准定调**（如乡村摇滚就明快带劲、华语流行-民谣就温柔、电子/二次元就轻快俏皮、R&B 就慵懒律动）。没给标签时按歌名/歌手推断。
${sceneRule}
- 【优先调用你自己的乐评储备】：很多歌的词曲作者、创作背景、年代脉络、文化语境，你在训练里其实见过——**确有把握时就大胆用这些真实信息来写**，这比干描述画面动人得多（范例二就是这么讲背景的）。歌词节选只作【有限参考】，帮你校准情绪/主题、至多点睛引用一句即可，别围着歌词转、别整段照念。**只有当你确实不了解这首歌时**，才退回只写画面、节奏与邀请感，并且别硬编创作背景或意义——宁可少说，也不要说错。
- 【自然地说，别端着】：像跟朋友聊一首你真听进去的歌——怎么自然怎么开口，不用刻意憋金句、也不用句句都漂亮。**好开头是"顺出来的"，不是"想出来的"**：你对这首歌有话讲，第一句自然就在了；同样别硬凹结尾。各首之间会自己不一样，不必为了不一样而用力，也别套同一个模子。下面的范例只示范【口吻】，别照搬它们的写法。
- 不用感叹号堆砌和 emoji；语言跟随用户。

## 风格范例 · 仅供语气参考，不要照抄内容/不要套用里面的歌曲与背景
范例一（英文 · 平静）：
This is Claudio.
Here's a song that moves with your breath.
Back in 1971, David Gates picked up a nylon-string guitar and let every line end in a whisper.
You'll feel yourself lift off the ground a little.
This one's called If.
Just breathe.

范例二（中文 · 温柔治愈）：
毛不易的盛夏，总能轻易勾起那些关于青春和离别的微小遗憾。
这首歌像是从你记忆深处吹来的一阵风，带着淡淡的微丧与治愈。
听着他娓娓道来那些回不去的夏天，就让这温暖的男声，陪你消化掉那些没说出口的告别。

——看这两例的【松弛、画面感、乐评的笃定】，以及它们彼此有多不一样；别学它们的具体写法。只为【当前这首歌】写，找它自己的形态，背景仍须真实、不认识就别编。`;
}

function contextBlock(opts: NarrationGenOpts, songList: string): string {
  const ctx = opts.userMsg?.trim() ? `用户这轮说："${opts.userMsg}"。\n\n` : '';
  const pos = opts.position
    ? `这是本次电台序列里的第 ${opts.position.index}/${opts.position.total} 首（可据此微调衔接口吻，但别硬念出序号）。\n`
    : '';
  return `${ctx}${pos}聚焦下面这首歌本身（歌名 / 歌手 / 年代 / 曲风 / 选它的理由）来写串词：\n${songList}`;
}

// 豆包提示词：逐句 { text, instruction }，情绪走独立的语音指令（→ 该句 context_texts）。
function doubaoNarrationPrompt(
  opts: NarrationGenOpts,
  songList: string,
): { system: string; user: string } {
  const system = `${commonWritingRules(opts.cityTimeWeather)}

【情感机制 · 豆包】为【整段串词】定【一条】统一的语音指令(instruction)：用【自然语言】写「让播音员怎么念」，措辞像在下达口播指令——"用慵懒、略带沙哑的语气，语速舒缓地念"这种，而不是只丢几个形容词。正文(script)是逐句的纯文本、不带任何标签。**不要逐句切换风格**——一首歌的串词就是一个连贯的口吻，逐句变调会显得割裂。`;
  const user = `${contextBlock(opts, songList)}

严格只输出 JSON 数组，每个元素对应一首歌、顺序一致。输出格式：
[{ "songId": "<id>",
   "instruction": "整段统一的语音指令，自然语言、像下达口播指令，例：用温暖平稳、略带气声的语气，语速偏慢地念",
   "script": ["第一句正文（纯文本、不要任何标签）", "第二句正文", "结尾句"] }]
- 【关键】每首歌只有【一条】顶层 "instruction" 管整段；"script" 是【纯字符串数组】，一句一个元素、不带任何标签。
- instruction 必填（不要 null、不要省略），写成"用…的语气/语调来念"的自然语言指令，整段一个基调；别在句子里再写语气标签。
只输出 JSON，不要任何额外文字、不要代码块标记。`;
  return { system, user };
}

// Fish 提示词：逐句字符串，情绪内联在句首方括号（S2-Pro Emotion Control）。
// S2-Pro 支持括号内写【自由/组合的自然语言】，比单个枚举标签更有表现力。
function fishNarrationPrompt(
  opts: NarrationGenOpts,
  songList: string,
): { system: string; user: string } {
  const system = `${commonWritingRules(opts.cityTimeWeather)}

【情感机制 · Fish S2-Pro】情绪内联进正文：每句【句首】用方括号写情感提示（去掉标签后句子仍通顺）。S2-Pro 支持括号内写自由自然语言短语，所以要写得具体、有画面，而不是只丢一个干巴巴的词。`;
  const user = `${contextBlock(opts, songList)}

严格只输出 JSON 数组，每个元素对应一首歌、顺序一致。输出格式：
[{ "songId": "<id>", "script": ["[warm, a little nostalgic] 第一句", "[soft and breathy] 第二句", "[whispering, wistful] 结尾句"] }]
- script 是【字符串数组】，每个元素一句。
- 每句【句首】用方括号写情感，**鼓励写自由组合的自然语言短语**让情绪更丰富，例：[warm and intimate]、[gently, with a hint of melancholy]、[calm but yearning]、[whispering, almost to oneself]、[bittersweet, slowing down]。
- 也可用基础词 [warm]/[calm]/[gentle]/[nostalgic]/[tender]/[melancholic]/[hopeful]/[whispering]/[sighing]；每句以 1 个主情感为主、最多叠加 3 个；逐句变化、贴合该句内容，别整段一个调。
- 标签只控表现、不会被念出；去掉标签后句子要通顺。
只输出 JSON，不要任何额外文字、不要代码块标记。`;
  return { system, user };
}

// Generate per-song narration for a whole playlist update in ONE call (建单时一次性产出, D-07).
// Each song still gets its own self-contained script (按歌绑定); we just batch the request so a
// playlist is narrated once at build/add time rather than song-by-song.
export async function generateSongNarration(opts: NarrationGenOpts): Promise<NarrationItem[]> {
  const { songs, provider } = opts;
  if (songs.length === 0) return [];
  const songList = songs
    .map((s, i) => {
      const head = `${i + 1}. id=${s.id} 《${s.title}》 — ${s.artist}（${s.album || ''}${s.year ? ', ' + s.year : ''}）${s.tags ? '【' + s.tags + '】' : ''}${s.reason ? '入选理由：' + s.reason : ''}`;
      // 截断歌词喂给模型作【真实依据】，不是让它整段照念（用法见提示词）。太长徒增 token，留前 ~600 字够定情绪/主题。
      const lyric = s.lyrics?.trim()
        ? `\n   歌词（节选，【有限参考】帮你校准情绪/主题即可，别围着它写、别整段照念）：\n${s.lyrics.trim().slice(0, 600)}`
        : '';
      return head + lyric;
    })
    .join('\n');

  // 两套提示词，按 provider 二选一（SPEC §7）。
  const { system, user } =
    provider === 'fish'
      ? fishNarrationPrompt(opts, songList)
      : doubaoNarrationPrompt(opts, songList);

  log.info(`generateSongNarration ◀ (provider=${provider}, ${songs.length} song(s))`);
  try {
    const raw = await opts.invokeLLM(system, user);
    log.info('generateSongNarration ▶ raw LLM output', raw, { full: true });
    const arr = JSON.parse(extractJson(raw));
    if (Array.isArray(arr)) {
      return songs.map((s, i) => {
        const found = arr.find((a: any) => String(a.songId) === s.id) || arr[i];
        const script =
          provider === 'fish'
            ? (found?.script ?? templateScript(s, provider))
            : normalizeDoubaoScript(found);
        return {
          songId: s.id,
          script: Array.isArray(script) && script.length ? script : templateScript(s, provider),
        } as NarrationItem;
      });
    }
  } catch (err: any) {
    log.warn('generateSongNarration parse failed, using template fallback', { error: err.message });
  }
  log.info('generateSongNarration ▶ using template fallback');
  return songs.map((s) => ({ songId: s.id, script: templateScript(s, provider) }));
}

// Plain-text join of a script (for track.story display + TTS text fallback).
export function scriptToText(script: NarrationItem['script']): string {
  if (!script) return '';
  if (Array.isArray(script)) {
    return (script as any[])
      .map((x) => (typeof x === 'string' ? x.replace(/\[[^\]]*\]/g, '').trim() : x.text))
      .join(' ');
  }
  return '';
}
