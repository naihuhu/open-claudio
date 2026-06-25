# Open Claudio

Claudio 把「懂音乐的乐迷」和「能动手的私人选曲师」合进同一个 Agent：它接管网易云音乐的曲库与你本地的网页播放器，既能根据一句话搜歌建单、回答歌曲/歌手/曲风的问题，也能真的把歌放出来、调好队列。开启私人 FM 后，它会在每首歌播放时，以深夜电台 DJ 的口吻，结合当前歌曲、所在城市的天气与时间，现场生成并念出一段串词。

> 创意与原型来自 [mmguo.dev](https://mmguo.dev)，本仓库是对其的一个开源复刻实现。

## 它能做什么

- **对话选曲与建单** —— 用自然语言找歌、攒歌单、补充或删减队列，而不是从固定列表里点。
- **聊音乐** —— 歌曲背景、歌词含义、专辑、曲风都能问；拿不准的事实会直说不确定，不编造。
- **真正控制播放器** —— 播放/暂停、上一首/下一首、跳转、音量、队列增删，由 Agent 通过工具直接驱动网页客户端。
- **私人 FM** —— 启动即进入一条不断续的单曲流，听完一首接一首，不需要先攒好歌单。
- **电台 DJ 串词** —— 仅在 FM 模式下，逐曲在播放时生成口播，叠加在音乐之上（客户端做 ducking 压低背景音）。串词带城市天气与时间感，语气是贴近麦克风的深夜电台主持。
- **品味档案** —— 读取你网易云的听歌频率、喜欢的歌、自建歌单，聚合成一份以「艺人 + 权重」为核心的品味画像，供选曲时参考。

## 快速开始

### 环境要求

- Node.js 20+
- 一个网易云音乐账号（用于登录取曲库与品味数据）
- 一个 OpenAI 兼容的 LLM 接口
- 一个 TTS key（[Fish Audio](https://fish.audio) 或[豆包语音](https://www.volcengine.com/product/voice-tech)，二选一即可），用于 DJ 串词语音

### 安装与运行

```bash
git clone https://github.com/naihuhu/open-claudio
cd open-claudio
npm install

cp .env.example .env      # 按下方「配置」说明填写
npm run dev               # 启动开发服务
```

启动后访问 http://localhost:3000

登录支持 Cookie 与扫码两种方式，登录后才能取到个人 FM、喜欢列表与品味数据。

## 配置

配置优先级为 **`config.json` > `.env` > 内置默认值**。`config.json` 是权威来源——在那里设过的值永远胜出；`.env` 只填补 `config.json` 留空的项，并在首次运行时种出一份 `config.json`。界面偏好（主题）、串词开关、默认 FM 开关等都存在 `config.json` 里，也可在设置界面直接改。

关键环境变量（完整说明见 [.env.example](.env.example)）：

| 变量 | 说明 |
| --- | --- |
| `LLM_API_ADDRESS` / `LLM_API_KEY` / `LLM_MODEL_NAME` | OpenAI 兼容的 LLM 接口 |
| `CLAUDIO_MAX_INPUT_TOKENS` | 每轮喂给模型的历史预算（默认 8000，大上下文模型可调高） |
| `TTS_PROVIDER` | `fish` 或 `doubao`；留空时自动择优（两者都配则 Fish 优先） |
| `DOUBAO_TTS_*` | 豆包语音合成的 key / 音色等 |
| `FISH_*` | Fish Audio 的 key、音色 id、语速、代理等（电台质感的主要调节项是 `FISH_TTS_REFERENCE_ID`） |
| `FM_DEFAULT` | 启动是否直接进入私人 FM（默认开，需登录网易云） |
| `CLAUDIO_DIR` | 持久化数据目录（默认 `~/.claudio`） |
| `PORT` / `HOST` | 服务监听地址（默认 `0.0.0.0:3000`） |
| `LOG_LEVEL` | `error` / `warn` / `info` / `debug`，可运行时改 |

## 架构

Claudio 是一个本地优先的应用：一个 Express 服务进程对外提供 API 并托管前端，所有音乐数据、品味档案、对话历史都落在本机的 `~/.claudio` 目录里。

- **模块 A · 品味档案** —— 从网易云抓取听歌记录、喜欢列表与自建歌单，去重聚合到「艺人 + 权重」，原子写入 `TASTE.md`。模块 B 只读这份档案。
- **模块 B · 音乐 Agent** —— 基于 LangGraph 的 `createAgent` 构建的单层 ReAct Agent，音乐工具（搜索、建单、查询）和播放器工具（队列、播放控制）平铺在同一层，带副作用的工具把指令搭车在事件流里交给客户端执行。这里刻意用裸 LangGraph 而非 deepagents，以避免后者「先规划再执行」的内置诱导让较弱的模型反复搜索却不提交。
- **串词与 TTS** —— 串词独立于 Agent，由 `/api/narration` 在每首歌播放时按当前歌曲生成输出一段 mp3 供前端叠播。

## 技术栈

- **后端**：Node.js + TypeScript + Express
- **AI**：LangChain / LangGraph，对接任意 OpenAI 兼容的 LLM
- **音乐**：网易云音乐 API（`@neteasecloudmusicapienhanced/api`，进程内调用，无 HTTP 转发）
- **语音**：豆包语音合成 / Fish Audio 双 TTS（两者都配则 Fish 优先）
- **前端**：React 19 + Vite + Tailwind CSS
- **持久化**：本地文件 + SQLite（对话 checkpoint）

## 开发

```bash
npm run dev            # 开发服务（tsx 直跑 server.ts）
npm run build          # 构建前端 + 打包服务到 dist/
npm run start          # 跑构建产物
npm run typecheck      # tsc 类型检查
npm run lint           # ESLint
npm run format         # Prettier
```

### Docker

```bash
docker compose up --build
```

## 关于本项目

本项目源于个人对 Agent 技术的探索与学习，旨在记录实践、分享思路，无任何商业意图。

- 与网易云音乐并无官方关联，仅借助社区维护的第三方接口，读取使用者本人账号下的数据。
- 不存储、不分发任何音乐内容，相关版权均归原权利方所有。
- 欢迎用于学习与二次创作；若作他用，请自行遵循相关服务的条款，并自负其责。

## 许可

基于 [MIT 许可证](LICENSE) 开放：可自由使用、修改与分发，按「现状」提供，不附带任何明示或默示的担保。
