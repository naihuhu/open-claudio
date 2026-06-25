// Host-side TTS adapter (SPEC «模块 B：TTS 接入» / D-18 / D-19).
// Single abstraction, switches Doubao(豆包) ⇆ Fish by TTS_PROVIDER.
// Input is per-sentence narration; output is one concatenated audio Buffer (mp3) the
// browser plays as it overlays on the music channel (ducking handled client-side).
import { randomUUID } from 'crypto';
// Use undici's OWN fetch + ProxyAgent together (same version) — passing undici@8's ProxyAgent
// as a dispatcher to Node's built-in fetch throws "invalid onRequestStart method".
import { ProxyAgent, fetch as undiciFetch } from 'undici';

export type Provider = 'doubao' | 'fish';

// One sentence of narration. For Doubao, `instruction` becomes that sentence's
// context_texts voice instruction; for Fish, emotion lives inline in `text` ([warm] …).
export interface Segment {
  text: string;
  instruction?: string | null;
}

export interface TtsConfig {
  provider: Provider;
  doubao: { apiKey: string; resourceId: string; appId?: string; speaker: string };
  fish: {
    apiKey: string;
    model: string;
    referenceId?: string;
    proxy?: string;
    volume?: number; // prosody.volume dB
    speed?: number; // prosody.speed 0.5~2.0 (radio cadence ~0.85~0.95)
    temperature?: number; // 0~1 expressiveness randomness (default 0.7)
    topP?: number; // 0~1
  };
  speechRate?: number; // doubao audio_params.speech_rate; fish prosody.speed mapped
}

const DOUBAO_URL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
const FISH_URL = 'https://api.fish.audio/v1/tts';

export function isConfigured(cfg: TtsConfig): boolean {
  if (cfg.provider === 'fish') return !!cfg.fish.apiKey;
  return !!(cfg.doubao.apiKey && cfg.doubao.resourceId);
}

// Normalize plain text into sentence segments (fallback when no structured script given).
export function textToSegments(text: string): Segment[] {
  const parts = text
    .split(/(?<=[.!?。！？])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return (parts.length ? parts : [text]).map((t) => ({ text: t, instruction: null }));
}

// ---- Doubao: ONE unidirectional request for the whole 串词 ----
// context_texts 是【整请求级】语音指令、列表仅第一个值有效(SPEC §7-A / D-19)。整段串词共用一条统一
// instruction，所以把所有句子拼成【一次】请求合成成连贯的「一段」，而不是逐句单发再拼接。
async function synthDoubao(segments: Segment[], cfg: TtsConfig): Promise<Buffer> {
  const text = segments.map((s) => s.text).join(' ');
  const instruction = segments.find((s) => s.instruction)?.instruction || '';

  const headers: Record<string, string> = {
    'X-Api-Key': cfg.doubao.apiKey.trim(),
    'X-Api-Resource-Id': cfg.doubao.resourceId.trim(),
    'X-Api-Request-Id': randomUUID(),
    'Content-Type': 'application/json',
  };
  if (cfg.doubao.appId?.trim()) headers['X-Api-App-Id'] = cfg.doubao.appId.trim();

  // additions MUST be a JSON string (implementation note in SPEC §6).
  const additions: any = {
    explicit_language: 'zh',
    disable_markdown_filter: true,
    section_id: randomUUID(),
    post_process: { pitch: 0 },
  };
  if (instruction) additions.context_texts = [instruction];

  const body = {
    user: { uid: 'claudio-host' },
    req_params: {
      text,
      speaker: cfg.doubao.speaker || 'zh_male_wennuanahu_uranus_bigtts',
      audio_params: { format: 'mp3', sample_rate: 24000, speech_rate: cfg.speechRate ?? 0 },
      additions: JSON.stringify(additions),
    },
  };

  const res = await fetch(DOUBAO_URL, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Doubao TTS ${res.status}: ${errText}`);
  }
  return readDoubaoStream(res);
}

// NDJSON / line-delimited stream: each line is JSON with base64 `data`.
async function readDoubaoStream(res: Response): Promise<Buffer> {
  let audio = Buffer.alloc(0);
  const reader = (res.body as any)?.getReader?.();
  if (!reader) return audio;
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  const flush = (line: string) => {
    const t = line.trim();
    if (!t || t.startsWith(':')) return;
    // tolerate both raw JSON lines and "data: {…}" SSE form
    const payload = t.startsWith('data:') ? t.slice(5).trim() : t;
    try {
      const obj = JSON.parse(payload);
      if ((obj.code === 0 || obj.code === undefined) && obj.data) {
        audio = Buffer.concat([audio, Buffer.from(obj.data, 'base64')]);
      }
    } catch {
      /* boundary fragment */
    }
  };
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      flush(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  }
  if (buffer.trim()) flush(buffer);
  return audio;
}

// ---- Fish: join sentences into one text, single chunked request ----
async function synthFish(segments: Segment[], cfg: TtsConfig): Promise<Buffer> {
  const text = segments.map((s) => s.text).join(' ');
  // Radio cadence: prefer explicit FISH_SPEED, else derive from speechRate, else a slow 0.9.
  const speed =
    cfg.fish.speed != null
      ? cfg.fish.speed
      : cfg.speechRate != null
        ? Math.min(2, Math.max(0.5, 1 + cfg.speechRate / 100))
        : 0.9;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.fish.apiKey.trim()}`,
    model: cfg.fish.model || 's2-pro',
    'Content-Type': 'application/json',
  };
  const body: any = {
    text,
    format: 'mp3',
    // normalize_loudness flattens output to a fixed perceived loudness, which cancels the dB
    // gain and makes Fish sound quieter than Doubao — turn it OFF so `volume` actually applies.
    prosody: { speed, volume: cfg.fish.volume ?? 8, normalize_loudness: false },
  };
  if (cfg.fish.referenceId?.trim()) body.reference_id = cfg.fish.referenceId.trim();
  if (cfg.fish.temperature != null) body.temperature = cfg.fish.temperature;
  if (cfg.fish.topP != null) body.top_p = cfg.fish.topP;

  // Fish needs a proxy from mainland China; route ONLY this request through it (per-request
  // dispatcher) so netease/doubao stay on the default direct connection.
  const fetchOpts: any = { method: 'POST', headers, body: JSON.stringify(body) };
  if (cfg.fish.proxy?.trim()) fetchOpts.dispatcher = new ProxyAgent(cfg.fish.proxy.trim());
  const res = await undiciFetch(FISH_URL, fetchOpts);
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Fish TTS ${res.status}: ${errText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return buf;
}

// Returns mp3 bytes. Throws on hard failure so caller can degrade (B-R7: skip narration).
export async function synthesize(segments: Segment[], cfg: TtsConfig): Promise<Buffer> {
  const segs = segments.filter((s) => s.text && s.text.trim());
  if (segs.length === 0) return Buffer.alloc(0);
  return cfg.provider === 'fish' ? synthFish(segs, cfg) : synthDoubao(segs, cfg);
}
