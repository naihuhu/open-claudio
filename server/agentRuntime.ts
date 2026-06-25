// Shared runtime for Module B's agents (SPEC «模块 B：Agent 设计与工具契约»).
// The music assistant agent (musicAgent, with its tools split across musicTools + playerTools) and
// the narration sub-agent
// (narrationAgent) build on these shared types + tracing helpers, so the modules can reference one
// another without circular value imports.
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { Track, RawSong } from './netease';
import type { Provider } from './ttsAdapter';
import { makeLogger } from './logger';

const log = makeLogger('ModuleB');

// Render a message's content (string | content-parts array) down to plain text.
function contentToText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
  return '';
}

// Callback handler that traces an agent loop. Logs the FULL system prompt once (so you can verify
// exactly what the model was told — persona + behaviour + taste), then a compact
// view of the conversation the model sees each turn, plus what it decides (tool calls + spoken text).
// Tool inputs/outputs are logged separately by `traced`. `label` distinguishes nested agent loops.
export class AgentTraceHandler extends BaseCallbackHandler {
  name = 'AgentTraceHandler';
  private turn = 0;
  private loggedSystem = false;
  constructor(private label = 'agent') {
    super();
  }

  // Signature is loose on purpose (we only need the messages); langchain passes BaseMessage[][].
  handleChatModelStart(_llm: any, messages: any[][]): void {
    this.turn += 1;
    const msgs: any[] = messages?.[0] || [];

    // Dump the system prompt in full, once — this is the thing that was "missing" from the logs.
    if (!this.loggedSystem) {
      const sys = msgs.find((m) => m?._getType?.() === 'system');
      if (sys)
        log.info(`[${this.label}] SYSTEM PROMPT (full)`, contentToText(sys.content), {
          full: true,
        });
      this.loggedSystem = true;
    }

    // Compact view of every message the model sees this turn (role + preview + any tool calls),
    // so a loop is obvious from the log: you'll see the same tool repeating turn after turn.
    const view = msgs
      .map((m) => {
        const role = m?._getType?.() || '?';
        const text = contentToText(m?.content).replace(/\s+/g, ' ').trim().slice(0, 200);
        const calls = (m as any)?.tool_calls?.length
          ? ` ⚙︎[${(m as any).tool_calls.map((c: any) => `${c.name}(${JSON.stringify(c.args).slice(0, 80)})`).join(', ')}]`
          : '';
        return `    ${role}: ${text}${calls}`;
      })
      .join('\n');
    log.info(`[${this.label}] #${this.turn} ◀ model input (${msgs.length} msgs)\n${view}`);
  }

  handleLLMEnd(output: any): void {
    try {
      const gens = output?.generations?.[0] || [];
      const calls = gens.flatMap((g: any) => g?.message?.tool_calls || []);
      const text = gens
        .map((g: any) => g?.text)
        .filter(Boolean)
        .join(' ')
        .trim();
      if (calls.length) {
        log.info(
          `[${this.label}] #${this.turn} → calls`,
          calls.map((c: any) => ({ name: c.name, args: c.args })),
        );
      }
      if (text) log.info(`[${this.label}] #${this.turn} → says`, text);
    } catch (e: any) {
      log.warn('trace handleLLMEnd failed', { error: e.message });
    }
  }
}

// Wrap a tool's func so every invocation logs its input and the output handed back to the model.
// Works for both string-input (DynamicTool) and object-input (DynamicStructuredTool) funcs.
export function traced<T = string>(
  name: string,
  fn: (input: T) => Promise<string>,
): (input: T) => Promise<string> {
  return async (input: T) => {
    log.info(`tool ${name} ◀ input`, input ?? '');
    try {
      const out = await fn(input);
      log.info(`tool ${name} ▶ output (returned to model)`, out, { full: true });
      return out;
    } catch (err: any) {
      log.error(`tool ${name} threw`, { error: err.message });
      return `${name} failed: ${err.message}`;
    }
  };
}

export function extractObj(s: string): string {
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start !== -1 && end > start) return s.slice(start, end + 1);
  return s.trim();
}

export function extractJson(s: string): string {
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start !== -1 && end > start) return s.slice(start, end + 1);
  return s.trim();
}

export type PlayerOp = 'play' | 'pause' | 'resume' | 'skip' | 'stop';
export type QueueOp = 'set' | 'add' | 'remove' | 'clear';

export interface NarrationItem {
  songId: string;
  // Provider-specific script: doubao → [{text, instruction}], fish → [string].
  script: Array<{ text: string; instruction?: string | null }> | string[] | null;
}

export interface PlayerState {
  status: 'playing' | 'paused' | 'stopped';
  queue: Track[];
  currentIndex: number;
  personalFm: boolean; // 私人 FM 单曲流是否开着（客户端镜像过来，agent 靠它读真实状态）
  narration: boolean; // 逐曲解说（串词/报幕）开关是否开着（客户端镜像 + agent 用 narration_mode 翻转）
}

// Per-request mutable session the tools write into. Shared by the coordinator and both sub-agents:
// the selection sub-agent writes queueOp/queue/autoplay/playerOp, the narration sub-agent writes
// narration, the coordinator's control tools write playerOp/removedIds.
// A song surfaced by a selection tool, kept so commit_queue can resolve a chosen id back to its
// full song object (+ where it came from) without re-fetching.
export interface Candidate {
  song: RawSong;
  source: Track['source'];
}

export interface RadioSession {
  queueOp: QueueOp | null;
  queue: Track[]; // resulting queue (set/add) — full snapshot
  removedIds: string[];
  narration: NarrationItem[];
  autoplay: boolean;
  playerOp: PlayerOp | null;
  searchedIds: Set<string>; // anti-hallucination allow-list (B-R3 / D-12)
  candidates: Map<string, Candidate>; // id → song surfaced by a search tool (commit resolves from here)
  // Fine-grained player controls (each rides its own `op` to the client; see playerTools).
  seekTo: number | null; // jump playback to this many seconds
  volume: number | null; // 0..1
  muted: boolean | null; // mute toggle
  playIndex: number | null; // jump to this queue position
  fmMode: boolean | null; // turn the radio-style narration (串词) on/off
  personalFm: boolean | null; // start/stop the personal-FM single-track stream
}

export function newSession(): RadioSession {
  return {
    queueOp: null,
    queue: [],
    removedIds: [],
    narration: [],
    autoplay: false,
    playerOp: null,
    searchedIds: new Set(),
    candidates: new Map(),
    seekTo: null,
    volume: null,
    muted: null,
    playIndex: null,
    fmMode: null,
    personalFm: null,
  };
}

export interface AgentDeps {
  session: RadioSession;
  userId?: number;
  cookie?: string;
  tasteText: string;
  tasteReady: boolean;
  ttsProvider: Provider;
  // narration LLM (structured); separate call so chat prompt stays byte-stable (§7 note)
  invokeLLM: (system: string, user: string) => Promise<string>;
  getPlayerState: () => PlayerState;
  cityTimeWeather: string;
  userMessage?: string; // raw current-turn user text (fed to the narration sub-agent for context)
}
