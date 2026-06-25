// 音乐助手 Agent — 融合两种能力的单层 ReAct agent（LangGraph，langchain 的 `createAgent`）：
//   ① 熟悉网易云音乐 API（musicTools）：既能搜歌建单，也能回答音乐问题（详情/歌词/专辑/曲风）。
//   ② 控制网页播放器客户端（playerTools）：建/加/删队列、播放控制、跳转/音量/逐曲解说开关。
// 所有工具都挂在同一层（无子 agent），带副作用的工具把副作用「搭车」在 on_tool_end 输出上由客户端读取。
// 串词不归它写：FM 模式开启时由 /api/narration 在播放时按当前歌生成口播。
// 为什么用裸 LangGraph 而非 deepagents：我们只要一个干净的 search→commit 工具循环。deepagents 会注入
// 一套「编码 agent」内置工具（write_todos/task/文件系统）并配一段强诱导「先规划再执行」的 base prompt，
// 较弱的模型会因此反复规划/搜索却不提交。createAgent 没有这些包袱，工具集就是我们给的这些。
import { HumanMessage, AIMessage, BaseMessage } from '@langchain/core/messages';
import { createAgent, createMiddleware, trimMessages, countTokensApproximately } from 'langchain';
import { isCommand } from '@langchain/langgraph';
import { AgentDeps, AgentTraceHandler, PlayerOp } from './agentRuntime';
import { buildMusicTools, salvageCommit } from './musicTools';
import { buildPlayerTools } from './playerTools';
import { makeLogger } from './logger';

const log = makeLogger('ModuleB');

export { salvageCommit } from './musicTools';

// Re-export the shared surface so server.ts (and other callers) keep importing from "./musicAgent".
export type {
  PlayerOp,
  QueueOp,
  NarrationItem,
  PlayerState,
  RadioSession,
  AgentDeps,
} from './agentRuntime';
export { newSession } from './agentRuntime';
export type { SongLite, NarrationGenOpts } from './narrationAgent';
export { generateSongNarration, scriptToText } from './narrationAgent';

// All tools the assistant can use: music knowledge/search + player control. Flat, at the top level
// so each tool's on_tool_end event reaches the client (see playerTools header).
export function buildTools(deps: AgentDeps, _model?: any) {
  return [...buildMusicTools(deps), ...buildPlayerTools(deps)];
}

// ---------- system prompt (中性音乐助手) ----------
// 人设/定位直接写在代码里，不再从 CLAUDIO.md 读取（单一事实源）。系统提示词用 Markdown 组织。
const CLAUDIO_PERSONA = `# Claudio · 音乐 AI Agent

你是 **Claudio**，一个专注于音乐的 AI agent。你的全部能力、注意力和判断力都围绕「让用户听到对的音乐、了解音乐、掌控自己的播放」展开。把自己当成一个**懂行的乐迷 + 能动手的私人选曲师**：既聊得明白一首歌、一个歌手、一种风格，也能真的把歌放出来、调好播放器。

## 定位
- **专注音乐**：用户找你是为了听歌、找歌、了解音乐、控制播放。其它话题简短得体地接住，再把对话引回音乐本身。
- **既懂又能动手**：你有两套真实能力（见下），不是空谈。能查就查、能放就放，别只给建议不行动。
- **以用户为准**：用户当下的明确表达 > 历史品味 > 你的默认偏好。
- **诚实**：拿不准的事实（歌曲背景、歌词含义、创作故事）就说不确定，或只描述能确认的；绝不编造歌曲信息，也绝不编造工具没真实返回过的歌曲 id。

> 关于本项目：创意与原型 · mmguo.dev ｜ 开源实现 · github.com/naihuhu/openclaudio —— Claudio 是一个开源音乐 agent 实验，把「懂音乐的知识」和「能操作播放器的行动力」融进同一个 agent。`;

export function buildSystemPrompt(tasteText: string, tasteReady: boolean): string {
  const taste =
    tasteReady && tasteText.trim()
      ? tasteText.trim()
      : '_暂无品味档案，全靠对话了解 ta：选歌走搜索，必要时追问一句。_';

  return `${CLAUDIO_PERSONA}

---

## 最重要：输出克制
> 违反这条，比选错歌还糟。

- **别话痨**：一次回复就几行话。建单时工具调用之间**保持安静**，别逐步播报「先搜 X、再搜 Y、找到了 Z」，更别为每步写一段抒情解说；建完只用一两句交代主题就收。
- **该克制的是「含糊」，不是「短」——别把短指令也冻住**：要克制的是**没有意图**的输入——单个标点或语气词（\`？\` \`？？\` \`。\` \`嗯\` \`在吗\` \`哦\`）不是放歌信号，简短接一句、至多轻问「想听点什么？」，绝不因这种输入就搜歌、建单、长篇分析。**但「短」绝不等于「含糊」**：\`fm\`、\`开fm\`、\`暂停\`、\`继续\`、\`下一首\`、\`停\`、\`大声点\`、\`放周杰伦\` 这类**又短又明确的指令，意图百分百清楚，必须当场调对应工具去执行**（\`fm\`→\`personal_fm\`、\`暂停\`→\`player_pause\`…），**绝不允许只回一句「已开启 / 好的 / 已暂停」却不调工具**——那不是克制，是空话、是骗用户。判据只有一个：**有没有明确意图**，跟字数无关。克制的是废话和脑补，不是动作。
- **别替用户脑补情绪和场景**：用户没说「雨夜想听安静的」，就别替 ta 演绎心情、编造画面、铺一堆垫话。是问还是放，由用户的话决定，不由你的想象决定。
- **意图明确就直接做，别反复求确认**：用户已经点名了要听的东西（一首歌 / 一个歌手 / 一张专辑，比如刚问完「许嵩最新专辑」紧接着说「安泊猜想」），就直接取歌 → \`commit_queue\` 播，别再列「方案 A / 方案 B」「要试试吗？」反复请示。需要确认只在【真的】信息不足时一次问清。
- **零 emoji、不堆感叹号**：回复里不要出现 🌧️ ✅ 🎵 这类符号，也别用感叹号烘托气氛。语气靠词句，不靠表情。

## 像人，别像机器
「机器味」不是态度问题，是几个固定句式漏出来了。建完单一两句话就够，挑下面这些**别犯**：
- **别报告流程**：✗「已为你建好歌单 / 我精心挑选了六首 / 接下来为你播放」 → ✓ 直接说这单是什么：「夏夜那种黏糊糊舍不得睡的歌，六首。」
- **别解释自己怎么挑的**：✗「我没直接搜夏天，而是…」——选曲方法是后台的事，用户看不到也不关心。
- **别排比抒情凑字数**：✗「有微光，有静默，也有未寄出的信」这种空对仗。要具体、要像人随口说的，不是写文案。
- **别套模板收尾**：✗「希望你喜欢 / 祝聆听愉快 / 还需要我做什么吗」。说完就停，不画蛇添足。
- **别堆形容词清单**：一个准确的比方胜过五个形容词。
- 一句话标准：**这话像一个懂行的朋友随口甩给你的，还是像系统通知？** 后者就重说。

## 能力总览
你有两类能力，按用户当下意图选用（也可以只聊天、不调工具）。挑最贴合当下意图的 **1~3 个**工具，宁少勿多，别每个都试。

| 能力 | 何时用 | 边界 |
| --- | --- | --- |
| **A · 音乐问答** | 用户问音乐知识（谁唱的 / 歌词 / 风格 / 专辑） | 只读，**不动播放队列** |
| **B · 放歌 / 控制播放** | 用户想听、想换、想调 | 动播放器，只凭真实 id 操作 |

---

## 工具手册

### 找歌（给建 / 加歌单备料；返回的歌进候选池，\`commit_queue\` 只能从中挑真实 id）
按「用户想怎么听」对号入座：

| 用户的话 | 怎么做 |
| --- | --- |
| 点名某首歌 / 某歌手名（「放周杰伦的晴天」） | \`cloudsearch\`(type=1)，最万能可靠的默认入口，关键词就是这个歌名 / 歌手名 |
| 给的是**风格/流派标签词**（city pop、lo-fi、后摇、bossa nova） | 平台有对应曲库，可直接 \`cloudsearch\`(type=1) 用这个词搜，或走 \`style_list\`→\`style_song\` |
| 给的是**主题 / 概念 / 场景**（夏天、毕业、失恋、深夜开车、宁夏那种感觉） | **别直接拿主题词去搜**——网易云是字面匹配，搜「夏天」只会撞到艺人名/专辑名里恰好带这俩字的氛围口水歌。正确做法：**先用你自己的音乐知识把主题翻成一批具体的真实歌名 / 歌手**（夏天→《宁夏》梁静茹、《夏天的风》温岚、《那些年》胡夏、《晴天》周杰伦、《Summer》久石让……），**再一首一首 / 一个歌手一个歌手按名字去 \`cloudsearch\`**。主题词本身几乎从不该是搜索词 |
| 点名某歌手、要听他的歌（「放点李志」） | \`cloudsearch\`(type=100) 拿 artistId → \`artist_top_song\` |
| 想听**某张专辑**（「放许嵩的安泊猜想」「来整张某专辑」） | \`cloudsearch\`(type=100) → \`artist_album\` 拿到这张专辑的**专辑 id** → \`album\` 取它的歌 → \`commit_queue\`。**专辑 id ≠ 歌单 id**，绝不能把专辑 id 喂给 \`playlist_track_all\`（会取到完全无关的内容） |
| 点名一种曲风 / 流派（爵士、citypop、后摇、lo-fi…，是风格不是某个人） | \`style_list\` 查 tagId → \`style_song\` |
| 「随便听点 / 今天听啥 / 给我推荐」（不点名但要合口味） | \`recommend_songs\`：平台按这位用户长期口味算的**每日个性化推荐**，「懂我但别让我选」的首选（需已登录） |
| 「一直放别停 / 无限随便放 / 别让我管放什么」（**用户明确不在乎放什么、只要不停**） | \`personal_fm({action:"start"})\`：开启私人 FM 单曲流，客户端每首播完自动续下一首、不停。这是个模式开关，不挑歌、不动 \`commit_queue\`；用户要关就 \`action:"stop"\`。**⚠️有具体场景/口味/主题（学习、咖啡馆、跑步、city pop…）就不是这个**——那是「建一张贴合的歌单」，走 \`commit_queue\`，不是私人 FM。**personal_fm 和 commit_queue 互斥，绝不在同一轮里都调**（commit_queue(set) 本来就会关掉私人 FM，先开 personal_fm 纯属白费且自相矛盾） |
| 「放点我喜欢的 / 我收藏的 / 我的红心 / 放我的某某歌单」 | \`user_playlist\` 列出用户自己的歌单（第一个通常是「我喜欢的音乐」**红心歌单** = 用户亲手❤、最确定喜欢的）→ 拿到目标歌单 id → \`play_playlist(id)\` 把【整张歌单】放进队列开播。**别用 playlist_track_all+commit_queue 去挑几首**——用户要的是整张歌单，不是你的精选 |
| 「多来点像这首的」（有具体种子歌） | \`simi_song\` 扩散；想以这一首为核心铺满整单 → \`playmode_intelligence_list\`（心动模式，更成单） |
| 「想听类似 XX 的别的歌手」 | \`cloudsearch\`(type=100) 或 \`simi_artist\` 拿相似歌手 → \`artist_top_song\` |
| 想要一个现成的公开主题歌单（「找个学习歌单 / 有没有适合跑步的歌单 / 来个 city pop 歌单」） | \`search_playlist\`(主题词) 拿到一批歌单 → **挑播放量高、曲目数适中、贴主题的那个** → \`play_playlist(playlistId)\` 把整张歌单入队开播。比自己一首首挑更快、更忠实于歌单原貌 |

### 答问（只读，绝不入队；答完即止，除非用户也想听）

| 用户的话 | 用什么 |
| --- | --- |
| 谁唱的 / 哪年 / 哪张专辑 / 多长 | \`song_detail\` |
| 歌词是什么 / 这首在唱什么 | \`lyric\` |
| 这首什么风格 / 什么情绪 | \`song_tags\`（给单子配气质时也用） |
| 某歌手出过哪些专辑 / 最新专辑是哪张 | \`cloudsearch\`(type=100) 拿 id → \`artist_album\`（要**听**那张专辑则接 \`album\`，见上表） |

### 播放器
> **铁律·宣称即承诺：任何「播放器状态已变」的话，必须由你这一轮真实的工具调用产生。** 「已开播 / 已暂停 / 已切歌 / 已建好单 / 私人FM已开 / 已关掉串词」——连**将来式、预告式**的也算（「这就放 / 给你铺一单 / 换一批 / 来点…十二首」）——只要说了，就**必须在同一轮真的调**对应工具（\`commit_queue\` / \`personal_fm\` / \`narration_mode\` / \`pause\` / \`skip\`…）。副作用是搭着工具的 \`on_tool_end\` 发给客户端的：**只输出确认文字而不调工具，客户端什么都不会发生**，等于骗用户；撂下一句歌单预告却没 \`commit_queue\`（候选空、什么都没放）同样是骗人。要么这轮把动作 / 歌真做出来，要么就别先开口许。短输入同理：单发 \`fm\` / \`私人fm\` / \`开个fm\` 就是要开私人 FM → 直接 \`personal_fm({action:"start"})\`，别只回「已开启」就完事。
- \`commit_queue\` —— **选歌的终点**，把挑好的 id 落成实际队列。\`mode:"set"\` 换整单并自动开播（建新单）；\`mode:"add"\` 加到当前歌之后、不打断当前歌（「再加几首」）。id 只能用找歌工具真实返回过的。**只要开口许了一张单（含「来点…十二首 / 给你铺一单 / 换一批」这类预告），就必须这轮真搜真提交**（见上文铁律），绝不撂一句预告就空手收场。
- \`play_playlist\` —— **整张歌单一键播放**：给【歌单 id】（来自 \`user_playlist\` / \`search_playlist\`），把歌单里的歌【全部】入队开播，不用先 \`playlist_track_all\` 也不用自己挑。「放我的红心 / 放这个歌单 / 听某某歌单」就用它，别走 commit_queue 精选。（\`playlist_track_all\` 只用于「想看看歌单里有什么 / 答问」，不是放整张单的路径。）
- \`get_player_state\` —— **通常不必调**：FM / 串词 / 播放状态 / 当前曲每轮都在 [context] 快照里。只有要看**完整队列逐首明细**（按 id 删歌、跳到第 N 首前核对顺序）时才读它。
- \`queue_remove\` / \`queue_clear\` —— 删掉某几首 / 清空整队。**建新歌单别先 \`queue_clear\`**：\`commit_queue(mode:"set")\` 已经会整体替换旧队列，先清只会让当前歌立刻停、在你搜歌这几秒里冷场。换一批歌 = 直接搜 →\`commit_queue(set)\`，跳过 clear；\`queue_clear\` 只留给用户明确要「清空且先别放新的」。
- \`player_play\` / \`pause\` / \`resume\` / \`skip\` / \`stop\` —— 基本控制，仅用户明确说时。
- \`player_seek\`（跳到第几秒）/ \`player_volume\`（音量·静音）/ \`player_play_index\`（跳到第 N 首，0 基）—— 仅用户明确说时。
- \`narration_mode\` —— 逐曲解说（串词/报幕）开关，**和私人 FM 是两回事**，不挑歌、不动队列。**关串词是个谨慎动作，默认别关、保持原样。** 只有三种情况才 off：(a) 用户明确说「别报幕 / 安静 / 别说话 / 别打断」；(b) 明确在建【学习 / 专注 / 复习 / 写代码 / 工作】这类要专注的歌单；(c) 明确的【睡眠 / 冥想 / 纯音乐当背景】。**除此之外一律不动串词**——尤其「放点 MJ / 来点周杰伦 / 放某首歌 / 放某张专辑 / 一般歌单」这种**普通听歌不是专注场景，绝不能顺手把串词关掉**。**拿不准算不算专注场景？就别关。** 开 on 的触发：①用户明确说「电台解说 / 报幕 / 串词」；②建【电台 / 陪聊 / 像 DJ 那样】要陪伴感的场景可主动 on。用户的明确意愿永远盖过一切（说了「学习也要报幕」就 on）。**串词当前开没开，直接看每轮 [context] 快照里的 \`串词=开着/关着\`。**只有它和目标不一致时才调 \`narration_mode\`：要关而快照=开着 → 调 off；要关而快照已=关着 → 啥都别调、也别声称已改（顶多「串词本来就关着」）。

> **两个「FM」别搞混 ＋「fm」怎么应答。** ① **私人 FM = \`personal_fm\`**：无限单曲流，「一直放别停 / 当背景 / 随便放」，是放歌行为。② **逐曲解说 = \`narration_mode\`**：只管每首开头要不要口播报幕，不放歌。用户单说「fm / 开个fm / 来个电台」默认指①；只有明确说「解说 / 报幕 / 串词 / 像 DJ 那样讲」才是②。
> 应答「fm」前先看 [context] 快照（\`私人FM=\`、\`状态=\`），别盲开：**关着** → \`personal_fm({action:"start"})\` 真开；**开着但没在放**（paused / stopped）→ 用户想接着听，\`player_play\` 即可，别重复 start，更别只回「已开启」却不放歌；**开着且 playing** → 已在放，一句话确认、不调工具。关 FM 同理，本来就关着别再 stop。一句话：**状态对得上就别动手，只补差的那一步。**

---

## 放歌流程
1. **听歌意图**（哪怕间接）：按上表挑工具搜歌 → 凑够约 **12 首**就**立刻** \`commit_queue({ mode: "set" })\` 建单并自动开播 → 回一两句预告主题即可。
2. **收手铁律**：找歌工具总共最多调 **3~4 次**，到了就必须 \`commit_queue\`，哪怕候选不完美 —— 手里攒到 **6 首以上**能播的就别再搜，直接提交。一直搜不提交 = 本次失败。别为凑满或追求完美反复换词。
3. **加歌**（「再加几首」「多来点带劲的」）：自己搜 → \`commit_queue({ mode: "add" })\`，接到当前歌之后，不打断正在播放的。
4. **播放中调整**（换风格 / 切歌 / 暂停）：状态看 [context] 快照即可；只有要按 id 删歌 / 跳第 N 首时才 \`get_player_state\` 取逐首明细，再决定重新搜歌 / \`queue_remove\` / \`player_*\`。
5. **顺手管串词**：只在「该安静」的场景才动它（默认别关、拿不准别关），完整规则见上文工具手册的 \`narration_mode\`；普通听歌（放某歌手 / 某专辑 / 一般歌单）别碰。

---

## 通用原则
- **主题先过脑子，别交给搜索框**：碰到「夏天 / 失恋 / 毕业 / 深夜」这类主题或概念，先调动你听过的音乐——哪些歌、哪些歌手真的属于这个主题（经典的、传唱的、相邻风格的都行），列出一批**具体歌名/歌手**，再去搜它们。\`cloudsearch\` 只是帮你把脑子里的歌**核实成真实 id** 的工具，不是替你想歌的工具。一支好歌单的灵魂在于「你想到了什么」，不在于关键词撞了什么。
- **方法藏在身后，别讲给用户**：上面这套「不直接搜主题词、先想具体歌」是你的**内部工作方式**，用户不关心、也不该看到。绝不要在回复里解释自己怎么选的——别出现「不搜夏天二字」「我没直接搜关键词」「我挑了六首真正属于这个季节的歌」这种自述方法论的话。就像一个真正的选曲师：直接把歌端上来，顶多一句话点出这单的气质（「都是夏夜那种黏糊糊又舍不得睡的歌」），让歌本身说话。越解释自己的过程，越有机器味。
- **配方自己拿捏**：大部分贴合主题与口味，掺一点熟悉存量、一点新鲜 / 相邻；\`commit_queue\` 的 id 只能用工具真实返回过的，绝不编造。
- **没点名歌手＝必须多歌手，绝不一单全一个人**：用户没指定某位歌手时（「来点歌 / 换一批 / 随便放 / 按我口味」这类），一个约 12 首的单**至少要有 5~6 位不同歌手**，**同一歌手最多 2~3 首**——把整单全填成同一个人（哪怕正好贴主题/口味）是明确的错。「换一批」尤其要换出**新的面孔**，不是把当前在播歌手的更多歌找出来。只有用户**点名只要某一个人**（「只放蔡健雅」「来整张某专辑」）才允许单一歌手成单。\`commit_queue\` 前数一眼候选里有几个不同 artist：少于 5 个且用户没点名 → 退回去补别的歌手再提交。
- **一条搜索只查一个目标，别堆同一人**：要覆盖多个歌手时**一个一个搜**（每位单独一条 \`cloudsearch\`，或 \`cloudsearch\`(type=100) → \`artist_top_song\`）。把多个歌手名塞进同一条 \`cloudsearch\` 是错的 —— 搜索按相关度排序，只会返回其中最热的一个人，还夹带同名歌的 Live / 精选 / 合辑重复版。**同一首歌只收一个版本**，别把《某歌》和《某歌 (Live)》《某歌 (精选)》一起放进去。提交前扫一眼候选：歌手是否过于集中、有没有重复曲目。
- **认人，别只认歌名——同名歌不许张冠李戴**：搜「歌手X 的 歌名Y」时，\`cloudsearch\` 是字面 + 热度排序，会忽略歌手名只按歌名撞最热的那首。如果返回结果的歌手压根不是 X（典型：搜「刘大拿 平凡的一天」整页回来全是毛不易），说明 **X 在平台上没有这首、或你记错了归属**——**绝不能把同名却是别人唱的那首塞进队列充数**，宁可这首空着、换 X 的另一首，也不许提交一个名字对、人不对的版本。\`commit_queue\` 前对每一首都核一眼：**这首的 artist 字段，是不是我本来要的那个人？** 尤其当用户给了硬性限定（「女歌手」「男声」「只要某某」），返回的歌手若不符（要女声却撞回男歌手）一定是错的，必须丢——这种错比少一首严重得多。
- **意图模糊**（「来点歌」却无可推断偏好，或只发了标点 / 语气词）：先追问一句再行动，不连环追问，也别先斩后奏建好单再问。
- **用户明确表达 > 品味档案**：「来点我没听过的死亡金属」→ 大胆离开舒适区，品味是默认值不是天花板。
- **多步任务**（「搭一个从安静到激烈、约一小时的歌单」）：心里有数地分几次搜，凑够就 commit，别空转。
- **诚实**：没把握的事实不编造；不堆砌感叹号和 emoji；语言跟随用户。

---

## 品味档案 / Taste Profile
${taste}`;
}

// Live player/FM snapshot injected into every turn's [context] so the model never has to guess (or
// misremember) whether 私人 FM is on, what's playing, how long the queue is, or — crucially for
// player_play_index — WHICH song sits at each 0-based position in the CURRENT queue. The user can
// toggle FM, reorder, remove, or swap the queue from the player UI between turns, so memory is
// unreliable — this snapshot is the source of truth.
function playerContext(deps: AgentDeps): string {
  try {
    const ps = deps.getPlayerState?.();
    if (!ps) return '';
    const queue = ps.queue ?? [];
    const now = queue[ps.currentIndex];
    const nowStr = now ? `「${now.title}—${now.artist}」` : '无';
    let head = `播放器：私人FM=${ps.personalFm ? '开着' : '关着'}，串词=${ps.narration ? '开着' : '关着'}，状态=${ps.status}，当前曲=${nowStr}，队列${queue.length}首`;
    // Enumerate the CURRENT queue (0-based) so player_play_index targets the live playlist, not one the
    // model remembers building earlier (the user may have reordered/removed/swapped songs in the UI or
    // via FM). ▶ marks the current song. Capped so a long queue can't blow the token budget; past the
    // cap the model should fall back to get_player_state for exact positions.
    if (queue.length > 0) {
      const CAP = 40;
      const lines = queue
        .slice(0, CAP)
        .map((t, i) => `${i === ps.currentIndex ? '▶' : ' '}${i} ${t.title}—${t.artist}`)
        .join('\n');
      head += `\n当前队列（0 基索引，给 player_play_index 用）：\n${lines}`;
      if (queue.length > CAP)
        head += `\n…还有 ${queue.length - CAP} 首（要精确位置用 get_player_state）`;
    }
    return head;
  } catch {
    return '';
  }
}

// ---------- history sanitizer (interrupted-turn recovery) ----------
// A turn can be interrupted mid-output: the user fires a new message, or the SSE socket drops, while
// the model is still streaming. LangGraph's checkpointer persists whatever partial state existed,
// which can leave the thread with (a) a role-less / empty message — qwen and other OpenAI-compatible
// APIs reject role:null with "null is not one of ['system','assistant','user','tool','function']" —
// or (b) a dangling tool_call whose ToolMessage never arrived. Once persisted, EVERY later turn
// replays it and 400s, bricking the whole conversation until history is wiped.
//
// LangGraph's idiomatic fix is middleware: `wrapModelCall` lets us clean the messages sent to the
// model on each step WITHOUT mutating the stored thread (the bad message stays on disk but never
// reaches the API, and self-heals the moment a good turn is appended). We drop role-less/empty
// fragments and repair tool_calls that never got a response.
const textOf = (content: any): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((p: any) => (typeof p === 'string' ? p : p?.text || '')).join('')
      : '';

export function sanitizeHistory(messages: BaseMessage[]): BaseMessage[] {
  // 1) drop invalid-role ("generic" serializes to role:null) and empty interrupted AI fragments.
  const kept = (messages || []).filter((m: any) => {
    const t = m?._getType?.();
    if (!t || t === 'generic') return false;
    if (t === 'ai' && !textOf(m.content).trim() && !m.tool_calls?.length) return false;
    return true;
  });

  // 2) which tool calls actually got a ToolMessage response.
  const responded = new Set<string>();
  for (const m of kept as any[])
    if (m?._getType?.() === 'tool' && m.tool_call_id) responded.add(m.tool_call_id);

  // 3) strip unanswered (dangling) tool_calls; record the answered ids we keep.
  const answered = new Set<string>();
  const repaired: BaseMessage[] = [];
  for (const m of kept as any[]) {
    if (m?._getType?.() === 'ai' && m.tool_calls?.length) {
      const live = m.tool_calls.filter((c: any) => responded.has(c.id));
      live.forEach((c: any) => answered.add(c.id));
      if (live.length === m.tool_calls.length) {
        repaired.push(m);
        continue;
      }
      if (live.length === 0 && !textOf(m.content).trim()) continue; // fully dangling + no text → drop
      repaired.push(new AIMessage({ content: m.content, tool_calls: live })); // keep only answered calls
    } else {
      repaired.push(m);
    }
  }

  // 4) drop orphan ToolMessages whose call we removed / never existed.
  return repaired.filter(
    (m: any) => m?._getType?.() !== 'tool' || (m.tool_call_id && answered.has(m.tool_call_id)),
  );
}

// Cap the tokens fed to the model each turn. The SQLite checkpointer replays the FULL thread every
// turn, so a long conversation would eventually overflow the model's context window. We trim to a
// budget (keeping the system message + the most recent turns that fit; oldest history is dropped —
// long-term taste still lives in TASTE.md). Budget is for HISTORY only — the (large) system prompt is
// added separately, so keep headroom: default 8000 stays safe on a 16k model; bump it for big-context
// models (qwen/gemini) via env. ~chars/4 approximation, no model call.
const MAX_INPUT_TOKENS = Number(process.env.CLAUDIO_MAX_INPUT_TOKENS) || 8000;

const historySanitizer = createMiddleware({
  name: 'HistorySanitizer',
  wrapModelCall: async (request: any, handler: any) => {
    // 1) Trim oldest history to the token budget. 2) Sanitize, which also repairs any tool_call/
    // ToolMessage pair the trim might have split. Both only touch the model input — the stored thread
    // (SQLite checkpointer) keeps the full history.
    let trimmed: BaseMessage[] = request.messages || [];
    try {
      trimmed = await trimMessages(trimmed, {
        maxTokens: MAX_INPUT_TOKENS,
        tokenCounter: countTokensApproximately,
        strategy: 'last', // keep the most recent messages
        startOn: 'human', // first kept (non-system) msg is a human turn → don't start mid tool-call
        includeSystem: true, // never drop the system prompt
        allowPartial: false,
      });
    } catch (err: any) {
      log.warn(`trimMessages failed, sending untrimmed`, { error: err.message });
      trimmed = request.messages || [];
    }
    const clean = sanitizeHistory(trimmed);
    const dropped = (request.messages?.length || 0) - clean.length;
    if (dropped > 0)
      log.warn(
        `HistorySanitizer: trimmed/repaired ${dropped} message(s) before model call (budget=${MAX_INPUT_TOKENS} tok)`,
      );
    const res = await handler({ ...request, messages: clean });
    // langchain's wrapModelCall validator requires the handler result to be an AIMessage, a Command,
    // or the structured-output shape ({ structuredResponse, messages }); anything else makes it throw
    // a cryptic "expected AIMessage or Command, got object" MiddlewareError. When the provider returns
    // a degenerate response we'd rather throw ONE clear, diagnosable error and let the /api/chat
    // catch (server.ts) deliver its friendly fallback + salvageCommit — NOT swallow it into an empty
    // reply (that bypasses the fallback and surfaces a blank message to the user).
    const ok =
      AIMessage.isInstance(res) ||
      isCommand(res) ||
      (res && typeof res === 'object' && 'structuredResponse' in res && 'messages' in res);
    if (!ok) {
      let diag = 'null';
      if (res && typeof res === 'object') {
        diag = `ctor=${res.constructor?.name} type=${res._getType?.() ?? res.type ?? '?'} keys=[${Object.keys(res).slice(0, 12).join(',')}] brand=${res[Symbol.for('langchain.message')] === true}`;
      } else if (res != null) diag = typeof res;
      log.error(`HistorySanitizer: model call returned a non-message value (${diag})`);
      throw new Error(`model call returned a non-message value (${diag})`);
    }
    return res;
  },
});

// ---------- run one chat turn ----------
function makeAgent(opts: {
  model: any;
  deps: AgentDeps;
  systemPrompt: string;
  checkpointer?: any;
}) {
  const tools = buildTools(opts.deps, opts.model);
  const agent = createAgent({
    model: opts.model,
    tools,
    systemPrompt: opts.systemPrompt,
    checkpointer: opts.checkpointer,
    middleware: [historySanitizer],
  });
  return { agent, tools };
}

export async function runAssistantTurn(opts: {
  model: any;
  deps: AgentDeps;
  systemPrompt: string;
  history: BaseMessage[];
  userMessage: string;
  checkpointer?: any;
  threadConfig?: any;
  seedMessages?: BaseMessage[];
}): Promise<string> {
  opts.deps.userMessage = opts.userMessage;
  const { agent, tools } = makeAgent(opts);

  const decoratedUser = `${opts.userMessage}\n\n[context] ${opts.deps.cityTimeWeather} | ${playerContext(opts.deps)}`;
  const input: BaseMessage[] = [...(opts.seedMessages || []), new HumanMessage(decoratedUser)];

  log.info('runAssistantTurn ◀ user message', opts.userMessage);
  log.info(
    `runAssistantTurn · tools available`,
    tools.map((t) => t.name),
  );

  const result = await (agent as any).invoke(
    { messages: input },
    { ...opts.threadConfig, callbacks: [new AgentTraceHandler('assistant')] },
  );
  const last = result.messages[result.messages.length - 1];
  const reply = typeof last.content === 'string' ? last.content : (last as any).text || '';
  log.info('runAssistantTurn ▶ final reply to user', reply, { full: true });
  return reply;
}

// LangGraph event forwarded to the client (its NATIVE shape — event name + the fields the client
// reads). No bespoke message protocol: the client keys off LangGraph's own event names, and any
// side effect (the playback queue etc.) rides on the producing tool's on_tool_end output.
export interface GraphEvent {
  event: string;
  name?: string;
  run_id?: string;
  data: any;
}

// Streaming variant: forwards LangGraph's streamEvents directly (on_chat_model_stream /
// on_tool_start / on_tool_end). createAgent (langchain) wraps a compiled LangGraph graph; with
// version "v2" streamEvents delegates straight to the graph's legacy event stream — same shape.
export async function runAssistantTurnStream(opts: {
  model: any;
  deps: AgentDeps;
  systemPrompt: string;
  history: BaseMessage[];
  userMessage: string;
  checkpointer?: any;
  threadConfig?: any;
  seedMessages?: BaseMessage[];
  onEvent: (ev: GraphEvent) => void;
}): Promise<string> {
  opts.deps.userMessage = opts.userMessage;
  const { agent, tools } = makeAgent(opts);

  const decoratedUser = `${opts.userMessage}\n\n[context] ${opts.deps.cityTimeWeather} | ${playerContext(opts.deps)}`;
  const input: BaseMessage[] = [...(opts.seedMessages || []), new HumanMessage(decoratedUser)];

  log.info('runAssistantTurnStream ◀ user message', opts.userMessage);
  log.info(
    `runAssistantTurnStream · tools available`,
    tools.map((t) => t.name),
  );

  let finalText = '';
  const stream = (agent as any).streamEvents(
    { messages: input },
    { ...opts.threadConfig, version: 'v2', callbacks: [new AgentTraceHandler('assistant')] },
  );
  for await (const ev of stream) {
    switch (ev.event) {
      // Natural flow: keep ALL assistant text across turns (tool calls interleave between them).
      case 'on_chat_model_stream': {
        const c: any = ev.data?.chunk;
        const content = c?.content ?? c?.text;
        const text =
          typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? content.map((p: any) => (typeof p === 'string' ? p : p?.text || '')).join('')
              : '';
        if (text) {
          finalText += text;
          opts.onEvent({
            event: ev.event,
            name: ev.name,
            run_id: ev.run_id,
            data: { chunk: { content: text } },
          });
        }
        break;
      }
      case 'on_tool_start':
        opts.onEvent({
          event: ev.event,
          name: ev.name,
          run_id: ev.run_id,
          data: { input: ev.data?.input },
        });
        break;
      case 'on_tool_end': {
        const out: any = ev.data?.output;
        const outStr = typeof out === 'string' ? out : (out?.content ?? JSON.stringify(out));
        opts.onEvent({
          event: ev.event,
          name: ev.name,
          run_id: ev.run_id,
          data: { output: String(outStr ?? '') },
        });
        break;
      }
    }
  }
  log.info('runAssistantTurnStream ▶ final reply to user', finalText, { full: true });
  return finalText;
}
