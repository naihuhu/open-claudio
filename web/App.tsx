import {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  Component,
  FC,
  FormEvent,
  ReactNode,
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  TextareaHTMLAttributes,
  CSSProperties,
} from 'react';
import { flushSync } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Square,
  Heart,
  Volume2,
  VolumeX,
  Send,
  Mic,
  MicOff,
  Disc,
  Radio,
  Sun,
  Moon,
  Volume1,
  MessageSquare,
  Globe,
  CornerDownLeft,
  Music4,
  Volume,
  Sliders,
  X,
  ChevronUp,
  Music,
  Maximize2,
  Minimize2,
  Cloud,
  CloudRain,
  CloudDrizzle,
  CloudSnow,
  CloudFog,
  CloudLightning,
  CloudSun,
  ArrowUpRight,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import rough from 'roughjs';
import Meyda from 'meyda';

interface Track {
  id: string;
  title: string;
  artist: string;
  album: string;
  duration: number; // in seconds
  url: string;
  story: string;
}

interface ToolCall {
  id: string;
  name: string; // netease 接口名
  input?: any; // tool args
  output?: string; // tool result (filled on tool_end)
  status: 'running' | 'done';
}

// A DJ message is an ordered sequence of text + tool blocks — natural flow: the AI may speak then
// call a tool, or call a tool then speak, any order, all kept.
type MsgBlock = { type: 'text'; text: string } | { type: 'tool'; tool: ToolCall };

interface Message {
  id: string;
  sender: 'claudio' | 'user' | 'system';
  text: string;
  timestamp: string;
  avatarUrl?: string;
  isPlayingAudio?: boolean;
  blocks?: MsgBlock[]; // ordered text/tool blocks (live + just-sent DJ turns); falls back to text
  streaming?: boolean; // true while tokens are still arriving
  queue?: Track[]; // the playlist this DJ turn committed — powers the "play this playlist" button
}

// Horizontal auto-scrolling text — only animates when content overflows its container.
function Marquee({
  children,
  className = '',
  gap = 48,
  speed = 35,
}: {
  children: ReactNode;
  className?: string;
  gap?: number;
  speed?: number;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLSpanElement | null>(null);
  const [overflow, setOverflow] = useState(false);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const measure = () => {
      const c = containerRef.current;
      const m = measureRef.current;
      if (!c || !m) return;
      const w = m.scrollWidth;
      setWidth(w);
      setOverflow(w > c.clientWidth + 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (containerRef.current) ro.observe(containerRef.current);
    if (measureRef.current) ro.observe(measureRef.current);
    return () => ro.disconnect();
  }, [children]);

  if (!overflow) {
    return (
      <div ref={containerRef} className={`overflow-hidden ${className}`}>
        <span ref={measureRef} className="inline-block whitespace-nowrap">
          {children}
        </span>
      </div>
    );
  }

  const distance = width + gap;
  const pause = 1.1; // seconds held still at each end
  const scrollTime = distance / speed;
  const total = scrollTime + pause * 2;

  return (
    <div ref={containerRef} className={`overflow-hidden ${className}`}>
      <motion.div
        className="flex w-max"
        style={{ gap, willChange: 'transform' }}
        animate={{ x: [0, 0, -distance, -distance] }}
        transition={{
          duration: total,
          times: [0, pause / total, (pause + scrollTime) / total, 1],
          ease: 'linear',
          repeat: Infinity,
        }}
      >
        <span ref={measureRef} className="inline-block whitespace-nowrap">
          {children}
        </span>
        <span className="inline-block whitespace-nowrap" aria-hidden>
          {children}
        </span>
      </motion.div>
    </div>
  );
}

// Hand-drawn border overlay (rough.js). Drops into any `position: relative` box as the
// first child and traces a sketchy rectangle matching the parent's size, redrawn on resize.
// Border-only (no fill) so the parent's own background and text show through untouched —
// used by the light "sketch" theme; never rendered in dark mode.
function RoughOverlay({
  stroke = '#b87333',
  strokeWidth = 1.7,
  roughness = 2.1,
  bowing = 1.8,
  inset = 4,
  seed = 42,
}: {
  stroke?: string;
  strokeWidth?: number;
  roughness?: number;
  bowing?: number;
  inset?: number;
  seed?: number;
}) {
  const holderRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Measure AND redraw imperatively inside the ResizeObserver callback — no React state hop.
  // ResizeObserver notifications are dispatched after layout but before paint, so redrawing here
  // lands the border in the same frame as the size change. Routing through setState (measure →
  // re-render → a separate draw effect) instead spanned several frames, so during streaming the
  // box grew token-by-token while the border lagged a beat behind and text spilled past it.
  useLayoutEffect(() => {
    const parent = holderRef.current?.parentElement;
    const svg = svgRef.current;
    if (!parent || !svg) return;
    let lastW = NaN,
      lastH = NaN;
    // For scrollable boxes (e.g. modals) use scrollHeight so the border wraps the full content,
    // not just the visible slice. For clipping boxes (overflow-hidden, like the main frame) stick
    // to clientHeight — scrollHeight would push the bottom edge below the clip and it'd vanish
    // when the viewport shrinks and content overflows.
    const draw = () => {
      const scrollable = /(auto|scroll)/.test(getComputedStyle(parent).overflowY);
      const w = parent.clientWidth;
      const h = scrollable
        ? Math.max(parent.clientHeight, parent.scrollHeight)
        : parent.clientHeight;
      if (w < 4 || h < 4 || (w === lastW && h === lastH)) return;
      lastW = w;
      lastH = h;
      svg.setAttribute('width', String(w));
      svg.setAttribute('height', String(h));
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      const rc = rough.svg(svg);
      const node = rc.rectangle(inset, inset, w - inset * 2, h - inset * 2, {
        stroke,
        strokeWidth,
        roughness,
        bowing,
        seed, // fixed seed → the wobble is stable across re-renders, not re-randomized each frame
      });
      svg.appendChild(node);
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [stroke, strokeWidth, roughness, bowing, inset, seed]);

  return (
    <div ref={holderRef} className="contents">
      <svg
        ref={svgRef}
        className="absolute inset-0 pointer-events-none"
        style={{ overflow: 'visible', zIndex: 1 }}
        aria-hidden
      />
    </div>
  );
}

// ---- Sketch control wrappers ----
// In the light "sketch" theme every form control renders as a wired-elements custom element
// (rough.js-drawn). In dark it falls back to the original Tailwind-styled native control, so the
// neon dark UI is untouched. wired controls take their stroke color from CSS `color`.
type Mode = 'dark' | 'light';
const SKETCH_INK = '#b5651d';

// Per-load nonce appended to /api/stream URLs. The stream endpoint re-resolves a fresh CDN url every
// request, but the browser keys its media cache on our stable `/api/stream?id=X`. A stale clip cached
// under that key (e.g. a 30s trial fetched before login) would otherwise stick forever — a normal
// reload won't revalidate it. Changing the URL per app load sidesteps any poisoned cache entry; the
// server's `Cache-Control: no-store` keeps new responses from being cached at all.
const STREAM_CACHE_BUST = Date.now();
const withCacheBust = (url: string) =>
  url.startsWith('/api/stream')
    ? `${url}${url.includes('?') ? '&' : '?'}_cb=${STREAM_CACHE_BUST}`
    : url;

// Clock font candidates for the light sketch theme — click the clock to cycle through them.
const CLOCK_FONTS: { name: string; stack: string }[] = [
  { name: 'Patrick Hand', stack: '"Patrick Hand", ui-rounded, cursive' },
  {
    name: 'SF Pro Rounded',
    stack: '"SF Pro Rounded", ui-rounded, "Hiragino Maru Gothic ProN", system-ui, sans-serif',
  },
  { name: 'Comic Sans', stack: '"Comic Sans MS", "Comic Neue", ui-rounded, cursive' },
  { name: 'Caveat', stack: '"Caveat", cursive' },
];

// Kitten avatars drawn as inline SVG (data-URI) — no network dependency, no external asset.
// Two moods, picked by theme: light = 可爱猫 (round, blushing, gentle smile); dark = 小野猫
// (feral — tall sharp ears, slanted neon slit-eyes, angry brows, a fang).
const svgURI = (inner: string) =>
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${inner}</svg>`,
  );

// 可爱猫 — soft round face, big round eyes with highlights, rosy cheeks.
const cuteCat = (bg: string, fur: string, ear: string, blush: string) =>
  svgURI(
    `<rect width="100" height="100" rx="26" fill="${bg}"/>` +
      `<path d="M27 36 L23 14 L45 27 Z" fill="${fur}"/>` +
      `<path d="M73 36 L77 14 L55 27 Z" fill="${fur}"/>` +
      `<path d="M30 31 L28 19 L40 27 Z" fill="${ear}"/>` +
      `<path d="M70 31 L72 19 L60 27 Z" fill="${ear}"/>` +
      `<circle cx="50" cy="55" r="29" fill="${fur}"/>` +
      `<circle cx="39" cy="53" r="4.8" fill="#2f2a33"/>` +
      `<circle cx="61" cy="53" r="4.8" fill="#2f2a33"/>` +
      `<circle cx="40.6" cy="51.2" r="1.6" fill="#ffffff"/>` +
      `<circle cx="62.6" cy="51.2" r="1.6" fill="#ffffff"/>` +
      `<circle cx="30" cy="61" r="4.2" fill="${blush}" opacity="0.6"/>` +
      `<circle cx="70" cy="61" r="4.2" fill="${blush}" opacity="0.6"/>` +
      `<path d="M46.5 59 L53.5 59 L50 63 Z" fill="#ef9a8a"/>` +
      `<path d="M50 63 Q46 68 42.5 64.5 M50 63 Q54 68 57.5 64.5" stroke="#6f5043" stroke-width="1.6" fill="none" stroke-linecap="round"/>` +
      `<g stroke="#6f5043" stroke-width="1.3" stroke-linecap="round" opacity="0.45">` +
      `<line x1="24" y1="57" x2="34" y2="58"/><line x1="24" y1="62" x2="34" y2="61"/>` +
      `<line x1="76" y1="57" x2="66" y2="58"/><line x1="76" y1="62" x2="66" y2="61"/>` +
      `</g>`,
  );

// 小野猫 — tall pointed ears, angry brows, slanted almond eyes with glowing iris + slit pupil,
// a smirk and a tiny fang.
const wildCat = (bg: string, fur: string, ear: string, iris: string) =>
  svgURI(
    `<rect width="100" height="100" rx="26" fill="${bg}"/>` +
      `<path d="M25 40 L17 7 L47 25 Z" fill="${fur}"/>` +
      `<path d="M75 40 L83 7 L53 25 Z" fill="${fur}"/>` +
      `<path d="M28 33 L23 14 L41 25 Z" fill="${ear}"/>` +
      `<path d="M72 33 L77 14 L59 25 Z" fill="${ear}"/>` +
      `<circle cx="50" cy="57" r="29" fill="${fur}"/>` +
      `<path d="M31 47 L45 51" stroke="#15121c" stroke-width="2.6" stroke-linecap="round"/>` +
      `<path d="M69 47 L55 51" stroke="#15121c" stroke-width="2.6" stroke-linecap="round"/>` +
      `<path d="M33 56 Q40 51 47 55 Q40 59 33 56 Z" fill="${iris}"/>` +
      `<path d="M67 56 Q60 51 53 55 Q60 59 67 56 Z" fill="${iris}"/>` +
      `<ellipse cx="40" cy="55.5" rx="1.3" ry="3.4" fill="#0d130d"/>` +
      `<ellipse cx="60" cy="55.5" rx="1.3" ry="3.4" fill="#0d130d"/>` +
      `<path d="M46.5 61 L53.5 61 L50 65 Z" fill="#e87f6f"/>` +
      `<path d="M50 65 Q45 70 40 66 M50 65 Q55 69 58 66" stroke="#1a1622" stroke-width="1.6" fill="none" stroke-linecap="round"/>` +
      `<path d="M45 66 L44 71 L47.5 66.5 Z" fill="#ffffff"/>` +
      `<g stroke="#ffffff" stroke-width="1.1" stroke-linecap="round" opacity="0.5">` +
      `<line x1="20" y1="58" x2="33" y2="59"/><line x1="20" y1="64" x2="33" y2="63"/>` +
      `<line x1="80" y1="58" x2="67" y2="59"/><line x1="80" y1="64" x2="67" y2="63"/>` +
      `</g>`,
  );

// light = 可爱猫 (Claudio ginger, listener blue-grey) · dark = 小野猫 (Claudio purple, listener teal)
const CLAUDIO_AVATAR_LIGHT = cuteCat('#fff0dc', '#f7c98f', '#eaa867', '#f4a9c0');
const CLAUDIO_AVATAR_DARK = wildCat('#1d1733', '#5a4a86', '#3d3160', '#caa8ff');

// Theme-matched placeholder avatars for the chat. The DJ wears the brand mark (disc badge in the
// brand purple/amber, mirroring the header logo); the listener gets a person silhouette tinted to
// the listener accent (teal in dark, rose in light) so each side reads as its own — both fills are
// pulled from the matching chat-bubble palette. Fills its wrapper circle. Deliberately NO glow halo
// in dark mode (the header mark's violet→teal blur is dropped here) so a column of avatars doesn't
// smear the feed with light.
function PlaceholderAvatar({ mode, role }: { mode: Mode; role: 'dj' | 'user' }) {
  const isDj = role === 'dj';
  const bg =
    mode === 'dark'
      ? isDj
        ? 'bg-[#120f26]'
        : 'bg-[#0b1f1c]'
      : isDj
        ? 'bg-[#fff8ee]'
        : 'bg-[#fff1f2]';
  const fg =
    mode === 'dark'
      ? isDj
        ? 'text-purple-400'
        : 'text-teal-400'
      : isDj
        ? 'text-amber-600'
        : 'text-rose-400';
  const Icon = Music4;
  return (
    <div className={`w-full h-full flex items-center justify-center ${bg}`}>
      <Icon className={`h-5 w-5 ${fg}`} />
    </div>
  );
}

function SketchButton({
  mode,
  sketchColor = SKETCH_INK,
  className,
  children,
  ...rest
}: { mode: Mode; sketchColor?: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  if (mode === 'light') {
    const { type: _t, ...other } = rest; // type=submit can't submit from shadow DOM; handled via onClick
    return (
      <wired-button className={className} style={{ color: sketchColor }} {...(other as any)}>
        {children}
      </wired-button>
    );
  }
  // Blur on click so a mouse-pressed button doesn't keep focus (and its focus styling) afterward —
  // it also hands focus back to <body>, where Space toggles play/pause instead of being swallowed.
  return (
    <button
      className={className}
      {...rest}
      onClick={(e) => {
        rest.onClick?.(e);
        e.currentTarget.blur();
      }}
    >
      {children}
    </button>
  );
}

function SketchIconButton({
  mode,
  sketchColor = SKETCH_INK,
  className,
  children,
  ...rest
}: { mode: Mode; sketchColor?: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  if (mode === 'light') {
    const { type: _t, ...other } = rest;
    return (
      <wired-icon-button className={className} style={{ color: sketchColor }} {...(other as any)}>
        {children}
      </wired-icon-button>
    );
  }
  // See SketchButton: blur after click so the control doesn't retain focus styling and Space keeps
  // controlling playback (focus returns to <body>) rather than being trapped on the button.
  return (
    <button
      className={className}
      {...rest}
      onClick={(e) => {
        rest.onClick?.(e);
        e.currentTarget.blur();
      }}
    >
      {children}
    </button>
  );
}

function SketchInput({
  mode,
  value,
  onValueChange,
  onEnter,
  sketchColor = SKETCH_INK,
  className,
  style,
  ...rest
}: {
  mode: Mode;
  value: string;
  onValueChange: (v: string) => void;
  onEnter?: () => void;
  sketchColor?: string;
  style?: CSSProperties;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'style'>) {
  const ref = useRef<any>(null);
  // True while an IME (拼音/かな…) composition is in flight. While it is, NOTHING may overwrite the
  // input's value — otherwise a re-render from the clock tick or audio-progress updates would
  // force-commit the half-composed text. (Native apps don't re-render 4×/sec, which is why typing
  // Chinese was fine there but broke here.)
  const composingRef = useRef(false);

  useEffect(() => {
    if (mode !== 'light') return;
    const el = ref.current;
    if (!el) return;
    if (!composingRef.current && el.value !== value) el.value = value ?? '';
    const onInput = (e: any) => onValueChange(e.target.value);
    const onCompStart = () => {
      composingRef.current = true;
    };
    const onCompEnd = (e: any) => {
      composingRef.current = false;
      onValueChange(e.target.value);
    };
    // wired-input's real <input> is in shadow DOM, so the host form's submit never fires on Enter.
    // Skip the Enter that confirms an IME (拼音) candidate so committing Chinese doesn't submit.
    const onKey = (e: any) => {
      if (e.key !== 'Enter') return;
      if (composingRef.current || e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      onEnter?.();
    };
    el.addEventListener('input', onInput);
    el.addEventListener('change', onInput);
    el.addEventListener('keydown', onKey);
    el.addEventListener('compositionstart', onCompStart);
    el.addEventListener('compositionend', onCompEnd);
    return () => {
      el.removeEventListener('input', onInput);
      el.removeEventListener('change', onInput);
      el.removeEventListener('keydown', onKey);
      el.removeEventListener('compositionstart', onCompStart);
      el.removeEventListener('compositionend', onCompEnd);
    };
  }, [mode, value, onValueChange, onEnter]);

  // Dark/native input is left UNCONTROLLED (defaultValue) so React never re-applies `value` on every
  // re-render. We only push external changes into the DOM here — clear-after-send, voice transcript —
  // and never during a composition. Normal typing already keeps el.value === value, so this is a no-op
  // for keystrokes and can't interrupt the IME.
  useEffect(() => {
    if (mode === 'light') return;
    const el = ref.current;
    if (el && !composingRef.current && el.value !== (value ?? '')) el.value = value ?? '';
  }, [mode, value]);

  if (mode === 'light') {
    return (
      <wired-input
        ref={ref}
        className={className}
        style={{ color: sketchColor, width: '100%', ...style }}
        {...(rest as any)}
      />
    );
  }
  return (
    <input
      ref={ref}
      defaultValue={value}
      onChange={(e) => onValueChange(e.target.value)}
      onCompositionStart={() => {
        composingRef.current = true;
      }}
      onCompositionEnd={(e) => {
        composingRef.current = false;
        onValueChange((e.target as HTMLInputElement).value);
      }}
      onKeyDown={(e) => {
        // While an IME composition is active, Enter confirms the 拼音 candidate — don't let it
        // bubble to the form's implicit submit and send the half-composed text.
        if (e.key === 'Enter' && ((e.nativeEvent as any).isComposing || e.keyCode === 229)) {
          e.preventDefault();
        }
      }}
      className={className}
      style={style}
      {...rest}
    />
  );
}

function SketchTextarea({
  mode,
  value,
  onValueChange,
  sketchColor = SKETCH_INK,
  className,
  style,
  ...rest
}: {
  mode: Mode;
  value: string;
  onValueChange: (v: string) => void;
  sketchColor?: string;
  style?: CSSProperties;
} & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange' | 'style'>) {
  const ref = useRef<any>(null);
  useEffect(() => {
    if (mode !== 'light') return;
    const el = ref.current;
    if (!el) return;
    if (el.value !== value) el.value = value ?? '';
    const handler = (e: any) => onValueChange(e.target.value);
    el.addEventListener('input', handler);
    el.addEventListener('change', handler);
    return () => {
      el.removeEventListener('input', handler);
      el.removeEventListener('change', handler);
    };
  }, [mode, value, onValueChange]);

  if (mode === 'light') {
    return (
      <wired-textarea
        ref={ref}
        className={className}
        style={{ color: sketchColor, width: '100%', ...style }}
        {...(rest as any)}
      />
    );
  }
  return (
    <textarea
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
      className={className}
      style={style}
      {...rest}
    />
  );
}

function SketchSlider({
  mode,
  value,
  onValueChange,
  min = 0,
  max = 100,
  step = 1,
  sketchColor = SKETCH_INK,
  className,
  style,
}: {
  mode: Mode;
  value: number;
  onValueChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  sketchColor?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const ref = useRef<any>(null);
  useEffect(() => {
    if (mode !== 'light') return;
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    // wired-slider draws its rough.js knob and measures its width lazily during Lit's async render
    // (no ResizeObserver — see wired-base). On a theme switch the element mounts fresh, and if we set
    // el.value before that knob SVG exists, updateThumbPosition() no-ops and the knob is stranded at
    // its far-left origin (the "复位到最左边" bug). Always assign value (so updateThumbPosition runs)
    // and re-assert it once the first render has completed and a frame has passed, so the knob lands
    // at the real volume instead of the input's default midpoint.
    const apply = () => {
      if (!cancelled) el.value = value;
    };
    apply();
    (el.updateComplete?.then ? el.updateComplete : Promise.resolve()).then(() => {
      apply();
      requestAnimationFrame(apply);
    });
    const handler = (e: any) =>
      onValueChange(typeof e.detail?.value === 'number' ? e.detail.value : Number(el.value));
    el.addEventListener('change', handler);
    el.addEventListener('input', handler);
    return () => {
      cancelled = true;
      el.removeEventListener('change', handler);
      el.removeEventListener('input', handler);
    };
  }, [mode, value, onValueChange]);

  // wired-base draws its rough.js track line ONCE at the width measured during the first Lit render
  // and never redraws on resize (no ResizeObserver upstream — see wired-base.wiredRender). The :host
  // default is 300px, so when this slider is a flex child that settles to a narrower width the line
  // stays drawn at the stale/wider size and bleeds past the end-time label. Force a redraw whenever
  // the element's box actually changes size so the line tracks the real width.
  useEffect(() => {
    if (mode !== 'light') return;
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      (el.updateComplete?.then ? el.updateComplete : Promise.resolve()).then(() =>
        el.wiredRender?.(true),
      );
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [mode]);

  if (mode === 'light') {
    return (
      <wired-slider
        ref={ref}
        style={{ color: sketchColor, display: 'block', ...style }}
        min={min}
        max={max}
        step={step}
      />
    );
  }
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onValueChange(Number(e.target.value))}
      className={className}
      style={style}
    />
  );
}

// Pick a lucide icon for the current weather. Prefer the WMO 4677 code (what Open-Meteo
// returns); if it's missing (older server build), fall back to the Chinese desc keywords.
function weatherIcon(code: number | undefined, desc = '') {
  if (typeof code === 'number') {
    if (code === 0) return Sun;
    if (code === 1 || code === 2) return CloudSun;
    if (code === 3) return Cloud;
    if (code === 45 || code === 48) return CloudFog;
    if (code >= 51 && code <= 57) return CloudDrizzle;
    if (code >= 71 && code <= 77) return CloudSnow;
    if (code === 85 || code === 86) return CloudSnow;
    if (code >= 95) return CloudLightning;
    if (code >= 61 && code <= 82) return CloudRain;
    return Cloud;
  }
  // desc fallback (order matters: check 毛毛雨/雷/雪 before the generic 雨/云)
  if (desc.includes('雷')) return CloudLightning;
  if (desc.includes('雾') || desc.includes('凇')) return CloudFog;
  if (desc.includes('雪') || desc.includes('雪粒')) return CloudSnow;
  if (desc.includes('毛毛雨')) return CloudDrizzle;
  if (desc.includes('雨')) return CloudRain;
  if (desc.includes('多云') || desc.includes('晴间')) return CloudSun;
  if (desc.includes('阴')) return Cloud;
  if (desc.includes('晴')) return Sun;
  return Cloud;
}

// Catches render-time errors in its subtree so one bad message/tool block can't white-screen the
// whole app (the generic "An error occurred in the <App> component" crash). Shows an inline notice
// instead; the rest of the UI (player, chat input) keeps working.
class ChatErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: any) {
    console.error('Chat render error (contained by boundary):', err);
  }
  render() {
    if (this.state.failed) {
      return (
        <div className="text-center select-none opacity-60 font-mono text-[10px] tracking-wide my-4 px-4">
          这条消息渲染时出错了，已为你跳过——其余功能照常。可刷新页面恢复完整历史。
        </div>
      );
    }
    return this.props.children;
  }
}

// Render chat text as markdown, tamed for the tight bubble (no big heading/paragraph margins).
const Markdown: FC<{ children: string }> = ({ children }) => (
  <div className="markdown-chat [&_p]:my-1 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-4 [&_li]:my-0.5 [&_a]:underline [&_code]:font-mono [&_code]:text-[0.92em] [&_pre]:whitespace-pre-wrap [&_pre]:break-all [&_h1]:text-sm [&_h1]:font-bold [&_h2]:text-sm [&_h2]:font-bold [&_h3]:font-bold [&_strong]:font-bold">
    <ReactMarkdown components={{ a: (p: any) => <a {...p} target="_blank" rel="noreferrer" /> }}>
      {children}
    </ReactMarkdown>
  </div>
);

// One DJ tool call: collapsed shows ONLY the tool name + a spinner (running) / ✓ (done). Click to
// expand the full input args and output (网易云接口的真实参数与返回).
const ToolCallRow: FC<{ tool: ToolCall; colorMode: string }> = ({ tool, colorMode }) => {
  const [open, setOpen] = useState(false);
  const dark = colorMode === 'dark';
  // Defensive: tool.output should arrive as a string (server coerces it), but a stale/older server
  // build can stream a ToolMessage object instead — rendering an object as a React child throws and
  // white-screens the whole app. Coerce both fields to strings so the chat can never crash here.
  const asText = (v: any): string =>
    v == null
      ? ''
      : typeof v === 'string'
        ? v
        : (() => {
            try {
              return JSON.stringify(v, null, 2);
            } catch {
              return String(v);
            }
          })();
  const fmtInput =
    tool.input && typeof tool.input === 'object' && Object.keys(tool.input).length
      ? asText(tool.input)
      : tool.input
        ? asText(tool.input)
        : '(no args)';
  const fmtOutput = asText(tool.output);
  return (
    <div
      className={`my-1 rounded border text-[9px] font-mono overflow-hidden ${dark ? 'border-purple-500/25 bg-purple-900/10' : 'border-amber-500/25 bg-amber-500/5'}`}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        className={`w-full flex items-center gap-1.5 px-1.5 py-1 text-left ${dark ? 'text-purple-300' : 'text-amber-700'}`}
      >
        {tool.status === 'running' ? (
          <span className="inline-block w-2.5 h-2.5 border border-current border-t-transparent rounded-full animate-spin flex-shrink-0" />
        ) : (
          <span className="opacity-70 flex-shrink-0">✓</span>
        )}
        <span className="font-bold tracking-tight">{tool.name}</span>
        <span className="opacity-40 flex-shrink-0 ml-auto">{open ? '▾ Hide' : '▸ Details'}</span>
      </button>
      {open && (
        <div
          className={`px-1.5 pb-1.5 space-y-1 border-t ${dark ? 'border-purple-500/15 text-slate-300' : 'border-amber-500/15 text-slate-600'}`}
        >
          <div className="pt-1">
            <span className="opacity-50">Input:</span>
            <pre className="whitespace-pre-wrap break-all opacity-90 mt-0.5">{fmtInput}</pre>
          </div>
          <div>
            <span className="opacity-50">Output:</span>
            <pre className="whitespace-pre-wrap break-all opacity-90 mt-0.5 max-h-40 overflow-auto">
              {tool.status === 'running' ? 'Running…' : fmtOutput || '(empty)'}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
};

// Player state is persisted to localStorage so a page refresh resumes where you left off
// (queue, current track, position, volume, favorites, personal-FM) instead of snapping back to the
// default seed track. isPlaying is intentionally NOT restored as "playing": browsers block autoplay
// without a fresh user gesture, so we always rehydrate paused and let the user tap play.
const PLAYER_STATE_KEY = 'claudio.player.v1';
const DEFAULT_TRACKS: Track[] = [
  {
    id: 'netease-1891454317',
    title: "All Too Well (Taylor's Version)",
    artist: 'Taylor Swift',
    album: "Red (Taylor's Version)",
    duration: 329,
    url: '/api/stream?id=1891454317',
    story: '',
  },
];
function loadPlayerState(): any {
  try {
    const raw = typeof localStorage !== 'undefined' && localStorage.getItem(PLAYER_STATE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export default function App() {
  // Theme state
  const [colorMode, setColorMode] = useState<'dark' | 'light'>('dark');
  // Theme switch driven through the View Transitions API so the whole window crossfades as ONE
  // motion instead of the root background easing over 700ms while every child snaps instantly
  // (the old "割裂感"). flushSync forces React to commit the new mode — and run the synchronous
  // sketch-decorator layout effect that paints the rough.js strokes — *before* the browser snapshots
  // the new frame, so the light theme is captured fully drawn and the strokes never pop in late.
  const switchTheme = (mode: 'dark' | 'light') => {
    if (mode === colorMode) return;
    const startViewTransition = (document as any).startViewTransition?.bind(document);
    const reduceMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (!startViewTransition || reduceMotion) {
      setColorMode(mode);
      return;
    }
    startViewTransition(() => flushSync(() => setColorMode(mode)));
  };
  // Which clock font (light theme); cycled by clicking the clock.
  const [clockFontIdx, setClockFontIdx] = useState(0);
  // Server-persisted UI preferences (theme + clock font). Gated so the local defaults above
  // don't overwrite the stored values before the initial /api/preferences fetch resolves.
  const prefsLoadedRef = useRef(false);

  // Real-time Clock state
  const [currentTime, setCurrentTime] = useState(new Date());

  // IP-located weather + city (refreshed every 30 min). See /api/weather (mirrors weather.py).
  const [weather, setWeather] = useState<{
    city: string;
    region: string;
    country: string;
    code: number;
    desc: string;
    temp: number;
    feelsLike: number;
    humidity: number;
    wind: number;
  } | null>(null);

  // Playlist states — rehydrated from localStorage on first render (see loadPlayerState).
  const persisted = useRef(loadPlayerState()).current;
  const [tracks, setTracks] = useState<Track[]>(
    Array.isArray(persisted?.tracks) && persisted.tracks.length ? persisted.tracks : DEFAULT_TRACKS,
  );
  const [currentTrackIndex, setCurrentTrackIndex] = useState(
    typeof persisted?.currentTrackIndex === 'number' ? persisted.currentTrackIndex : 0,
  );
  const [isPlaying, setIsPlaying] = useState(false); // never autoplay on load (browser gesture rule)
  // Live mirror of play intent, read by audio-element event handlers (canplay) that are bound once
  // and would otherwise capture a stale isPlaying.
  const isPlayingRef = useRef(isPlaying);
  const [audioProgress, setAudioProgress] = useState(0); // in seconds
  const [audioDuration, setAudioDuration] = useState(329); // in seconds
  const [volume, setVolume] = useState(
    typeof persisted?.volume === 'number' ? persisted.volume : 0.8,
  );
  const [isMuted, setIsMuted] = useState(!!persisted?.isMuted);
  // Where to resume the current track on first load (applied once on loadedmetadata).
  const resumeAtRef = useRef<number>(
    typeof persisted?.audioProgress === 'number' ? persisted.audioProgress : 0,
  );

  // Custom interactive states
  // Kept for player-state persistence backward-compat; the heart button now reflects Netease 红心.
  const [favorites] = useState<string[]>(
    Array.isArray(persisted?.favorites) ? persisted.favorites : [],
  );
  // 网易云红心状态：当前播放歌是否在「我喜欢的音乐」里。随当前歌变化重新查询。
  const [activeTrackLiked, setActiveTrackLiked] = useState(false);
  const [likeBusy, setLikeBusy] = useState(false);
  const [showQueue, setShowQueue] = useState(false);
  // Refs for auto-scrolling the queue to the currently-playing track when the panel opens.
  const queueScrollRef = useRef<HTMLDivElement | null>(null);
  const activeQueueRowRef = useRef<HTMLDivElement | null>(null);
  // 私人 FM 模式: when on, every time the current track finishes the client fetches ONE more song
  // from /api/personal-fm/next, appends it, and plays it — an endless single-track stream. Toggled
  // by the FM button or the agent's personal_fm({action}) tool. Turned off when a new playlist is set.
  // 初值恒为 false，故意【不】从上一次会话的本地标志恢复：浏览器禁止自动播放，单纯把标志恢复成 true 会得到
  // 「标志说开着、其实没有流、队列还是 259 首」的不一致状态（agent 读到假状态、用户再说 fm 也因没跳变而无反应）。
  // 默认 FM 不走「恢复旧标志」这条路，而是启动后由 config.fm.default（← config.json / FM_DEFAULT）显式重新拉起
  // 一首新鲜 FM（见下方 /api/config 启动 effect），队列也随之归 FM 所有——是真正的状态跳变，不是假恢复。
  const [personalFm, setPersonalFm] = useState(false);
  // One-shot latch so the config-driven default-FM (config.fm.default / FM_DEFAULT) only auto-starts
  // once on first load — after that the user's manual on/off is authoritative and never re-forced.
  const fmAutoStartedRef = useRef(false);
  // Tells the FM toggle effect that THIS particular start is the config default → cue a track but
  // stay paused (don't autoplay). Cleared the moment it's consumed; manual FM toggles autoplay as usual.
  const pendingFmPausedRef = useRef(false);
  const [chatMaximized, setChatMaximized] = useState(false);

  // Interactive Chat Feed states
  const [messages, setMessages] = useState<Message[]>([]);
  // Chat history loads newest-first in pages; these drive the "load earlier" control at the top.
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [inputText, setInputText] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);

  // Netease Integration States
  const [userSession, setUserSession] = useState<{
    isLoggedIn: boolean;
    nickname?: string;
    avatarUrl?: string;
    userId?: number;
  }>({ isLoggedIn: false });
  const [showQrModal, setShowQrModal] = useState(false);
  const [qrImg, setQrImg] = useState<string | null>(null);
  const [qrStatusText, setQrStatusText] = useState('');
  const [qrKey, setQrKey] = useState('');
  const [isCheckingQr, setIsCheckingQr] = useState(false);
  // Cookie login (official web login → paste cookie), bypasses QR risk control.
  const [cookieInput, setCookieInput] = useState('');
  const [cookieLoggingIn, setCookieLoggingIn] = useState(false);

  // Infinite history display, config modal, and tts properties
  const [visibleCount, setVisibleCount] = useState(10);
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [configState, setConfigState] = useState<any>({
    llm: {
      apiAddress: 'https://api.openai.com/v1',
      apiKey: '',
      modelName: 'gpt-3.5-turbo',
    },
    tts: {
      appId: '',
      apiKey: '',
      resourceId: '',
      voiceType: '',
      narration: false,
    },
    // 私人 FM 默认模式：app 启动是否直接进入 FM 单曲流（服务端 config.fm.default / FM_DEFAULT 决定）。
    fm: {
      default: true,
    },
  });
  const [tasteState, setTasteState] = useState('');
  const [isGeneratingTaste, setIsGeneratingTaste] = useState(false);
  const [showTastePrompt, setShowTastePrompt] = useState(false);
  const speechAudioRef = useRef<HTMLAudioElement | null>(null);

  // Count consecutive un-playable tracks so a string of bad songs doesn't loop forever.
  const consecutiveErrorsRef = useRef(0);

  // Audio HTML Tag Ref
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Audio-reactive ambient glow: Web Audio analyser taps the music so we can drive the
  // panel's --glow-pulse CSS variable from the live amplitude (see the rAF loop below).
  const audioCtxRef = useRef<AudioContext | null>(null);
  const meydaRef = useRef<ReturnType<typeof Meyda.createMeydaAnalyzer> | null>(null);
  const meydaFeatRef = useRef<any>(null); // latest features from Meyda's callback
  const mediaSrcRef = useRef<MediaElementAudioSourceNode | null>(null);
  const glowValRef = useRef(0.5); // smoothed --glow-pulse output
  const glowBaseRef = useRef(0); // slow baseline of bass energy (for kick onsets)
  const glowPeakRef = useRef(0.05); // AGC: adaptive peak of overall loudness
  const glowBassPeakRef = useRef(0.01); // AGC: adaptive peak of bass onset strength
  const speechRmsRef = useRef(0); // live RMS of the DJ voice (0 when not speaking)
  const glowSpeechPeakRef = useRef(0.03); // AGC: adaptive peak of the DJ voice
  const speechDetachRef = useRef<() => void>(() => {}); // tears down the current DJ→glow tap
  const musicVolRampRef = useRef<number | null>(null); // in-flight music volume ramp (duck/lift) — rAF fallback only
  // Music duck multiplier (1 = full, <1 = ducked under the DJ). Lives on the audio thread as a
  // GainNode so its ramps keep running when the browser window loses focus / is occluded — where
  // requestAnimationFrame (the old rAF volume tween) is throttled or paused and the fade stalled.
  const duckGainRef = useRef<GainNode | null>(null);
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const chatFeedRef = useRef<HTMLElement | null>(null);
  // When true, the next chat scroll effect jumps to the bottom regardless of where the user is —
  // set right after sending a message so the new turn's latest AI reply is always shown.
  const forceScrollRef = useRef(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // TTS Active Speaking state
  const [currentlySpeakingId, setCurrentlySpeakingId] = useState<string | null>(null);
  const [speechVoicesLoaded, setSpeechVoicesLoaded] = useState(false);

  // Fetch user session on mount
  useEffect(() => {
    fetch('/api/user/session')
      .then((res) => {
        if (res.ok) return res.json();
        throw new Error('fail');
      })
      .then((data) => {
        if (data && data.isLoggedIn) {
          setUserSession(data);
        }
      })
      .catch((err) => console.log('No stored Netease Cloud Music user session Found:', err));
  }, []);

  // Fetch real tracks from full-stack api on mount
  useEffect(() => {
    fetch('/api/tracks')
      .then((res) => {
        if (res.ok) return res.json();
        throw new Error('API response not ok');
      })
      .then((data) => {
        // 默认 FM 开着时，播放器队列归私人 FM 单曲流所有——别让这份普通大队列把它冲掉。
        // FM 若拉不到歌（未登录/风控）会自行关闭，届时这份 fallback 仍是空的，玩家保持 stopped，符合预期。
        if (personalFmRef.current) return;
        if (Array.isArray(data) && data.length > 0) {
          setTracks(data);
          setAudioDuration(data[0].duration || 158);
        }
      })
      .catch((err) => console.log('Using backup tracks playlist:', err));
  }, [userSession.isLoggedIn]);

  // Update clock every second
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Refresh location + weather every 30 minutes (fetch once on mount, then on interval).
  useEffect(() => {
    const loadWeather = () => {
      fetch('/api/weather')
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error('weather fetch fail'))))
        .then((data) => {
          if (data && !data.error) setWeather(data);
        })
        .catch((err) => console.log('Weather unavailable:', err));
    };
    loadWeather();
    const timer = setInterval(loadWeather, 30 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  // Audio setup and duration listeners
  useEffect(() => {
    if (!audioRef.current) return;

    // Set initial volume
    audioRef.current.volume = isMuted ? 0 : volume;

    const handleTimeUpdate = () => {
      if (audioRef.current) {
        setAudioProgress(audioRef.current.currentTime);
      }
    };

    const handleLoadedMetadata = () => {
      if (audioRef.current) {
        setAudioDuration(audioRef.current.duration || tracks[currentTrackIndex].duration);
        // On first load after a refresh, resume the restored track at its saved position (once).
        if (resumeAtRef.current > 0) {
          const at = Math.min(
            resumeAtRef.current,
            (audioRef.current.duration || resumeAtRef.current) - 1,
          );
          if (at > 0) {
            audioRef.current.currentTime = at;
            setAudioProgress(at);
          }
          resumeAtRef.current = 0;
        }
      }
      // A track loaded successfully → reset the bad-track streak.
      consecutiveErrorsRef.current = 0;
    };

    const handleEnded = () => {
      // 私人 FM 开着：播完不回到队首循环，而是拉下一首续上「不断的流」。
      if (personalFmRef.current) {
        fetchFmRef.current();
        return;
      }
      handleNextTrack();
    };

    // If a track can't be played (CDN/expired/decode/copyright), don't halt the queue —
    // auto-skip to the next one, with a guard so an all-bad queue doesn't loop forever.
    const handleError = () => {
      const failed = tracks[currentTrackIndex];
      consecutiveErrorsRef.current += 1;
      console.warn('Audio failed to play, skipping:', failed?.title, audioRef.current?.error);
      // 私人 FM 下一首坏了也别停流，直接再拉一首（带计数防一直拉到坏歌死循环）。
      if (personalFmRef.current && consecutiveErrorsRef.current < 6) {
        addSystemLog(`"${failed?.title ?? 'this track'}" 放不出，私人 FM 换下一首。`);
        fetchFmRef.current();
        return;
      }
      if (tracks.length > 1 && consecutiveErrorsRef.current < tracks.length) {
        addSystemLog(`"${failed?.title ?? 'this track'}" 无法播放，自动跳到下一首。`);
        handleNextTrack();
      } else {
        addSystemLog('队列里的歌暂时都放不出来（可能版权/网络问题），先停一下。');
        setIsPlaying(false);
        consecutiveErrorsRef.current = 0;
      }
    };

    // When a freshly-swapped src becomes playable, start it if we intend to be playing but the
    // element is still paused — covers the auto-skip case where the initial play() lost the race
    // with the src swap and rejected (AbortError). isPlayingRef avoids re-binding on every play/pause.
    const handleCanPlay = () => {
      if (isPlayingRef.current && audioRef.current?.paused) {
        audioRef.current.play().catch(() => {
          /* genuine unplayables surface via the error handler */
        });
      }
    };

    const audio = audioRef.current;
    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('loadedmetadata', handleLoadedMetadata);
    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('error', handleError);
    audio.addEventListener('canplay', handleCanPlay);

    return () => {
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
      audio.removeEventListener('ended', handleEnded);
      audio.removeEventListener('error', handleError);
      audio.removeEventListener('canplay', handleCanPlay);
    };
  }, [currentTrackIndex, volume, isMuted, tracks]);

  // Sync isPlaying state with html audio element.
  // Depends on the current track's URL (not just the index): when a new queue is committed while
  // already playing at the same index (e.g. commit_queue mode:"set" → still index 0, still playing),
  // <audio src> swaps to a different song but isPlaying/index don't change. Without the url in the
  // deps this effect wouldn't re-run, so the new source would load yet never .play() — the button
  // reads "playing" while nothing actually plays. Keying on the url makes a song swap call play().
  useEffect(() => {
    if (!audioRef.current) return;
    if (isPlaying) {
      // Lazily wire the <audio> through an analyser the first time the user actually plays
      // (AudioContext starts suspended under the autoplay policy, so it needs the gesture).
      ensureGlowAnalyser();
      audioCtxRef.current?.resume?.();
      audioRef.current.play().catch((err) => {
        // Only a genuine autoplay block (no user gesture yet) means we truly can't play → reflect
        // paused. An AbortError is transient: the play() got interrupted by the <audio src> swap
        // during an auto-skip (or by a pause()), so the NEW track is mid-load — don't pause it; the
        // canplay handler below starts it the moment it's ready. Pausing here was the bug that left a
        // perfectly playable next track stuck on "paused" after skipping a dead first track.
        if (err?.name === 'NotAllowedError') {
          console.warn('Autoplay blocked till interaction:', err);
          setIsPlaying(false);
        } else {
          console.warn('play() interrupted, will retry on canplay:', err?.name || err);
        }
      });
    } else {
      audioRef.current.pause();
    }
  }, [isPlaying, currentTrackIndex, tracks[currentTrackIndex]?.url]);

  // Tap the <audio> through Meyda once for feature extraction (createMediaElementSource may
  // only be called once per element, so guard on meydaRef). Meyda runs its own analysis and
  // hands us the latest features via callback. If the track's CDN doesn't send CORS headers the
  // features read silence (a browser security rule) and the glow stays calm — playback is never
  // affected.
  const ensureGlowAnalyser = () => {
    if (meydaRef.current || !audioRef.current) return;
    try {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      if (!Ctx) return;
      const ctx: AudioContext = new Ctx();
      const source = ctx.createMediaElementSource(audioRef.current);
      // source → duckGain → destination. Ducking rides this gain node (automated on the audio
      // thread) instead of the <audio>.volume property, so the duck/lift fade survives the window
      // losing focus. The user volume slider still drives <audio>.volume; the two multiply.
      const duckGain = ctx.createGain();
      duckGain.gain.value = 1;
      source.connect(duckGain);
      duckGain.connect(ctx.destination); // keep the music audible
      duckGainRef.current = duckGain;
      const analyzer = Meyda.createMeydaAnalyzer({
        audioContext: ctx,
        // Tap AFTER the duck so the glow reads the ducked music — when the DJ talks the song is
        // quiet here, letting the voice dominate the glow (matches the old volume-based duck).
        source: duckGain,
        bufferSize: 512,
        // rms = overall perceived loudness (drives the base glow, vocals included);
        // loudness.specific = bark bands, whose lowest bins are the kick/bass (drive the punch).
        featureExtractors: ['rms', 'loudness'],
        callback: (features: any) => {
          meydaFeatRef.current = features;
        },
      });
      analyzer.start();
      audioCtxRef.current = ctx;
      mediaSrcRef.current = source;
      meydaRef.current = analyzer;
    } catch (err) {
      console.warn('Audio-reactive glow unavailable:', err);
    }
  };

  // Smoothly ramp the music's duck multiplier to `factor` (1 = full, 0.22 ≈ ducked under the DJ)
  // over `ms` — used to fade the music down before the DJ speaks and lift it back after, instead of
  // snapping. Drives a Web Audio GainNode whose AudioParam ramp runs on the audio thread, so the
  // fade keeps progressing even when the browser window isn't focused / is occluded (where the old
  // requestAnimationFrame tween was throttled or paused and the fade simply stalled). Falls back to
  // an rAF tween on <audio>.volume only when Web Audio isn't wired up yet (no context/gain node).
  const duckMusicTo = (factor: number, ms: number) => {
    const clamped = Math.max(0, Math.min(1, factor));
    const gain = duckGainRef.current;
    const ctx = audioCtxRef.current;
    if (gain && ctx) {
      const now = ctx.currentTime;
      const g = gain.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now); // anchor at the current (possibly mid-ramp) value
      g.linearRampToValueAtTime(clamped, now + Math.max(0.001, ms / 1000));
      return;
    }
    // Fallback: no audio graph — tween the element volume (this path still stalls when unfocused).
    const audio = audioRef.current;
    if (!audio) return;
    if (musicVolRampRef.current) cancelAnimationFrame(musicVolRampRef.current);
    const target = (isMuted ? 0 : volume) * clamped;
    const from = audio.volume;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // easeInOutQuad
      audio.volume = Math.max(0, Math.min(1, from + (target - from) * e));
      if (t < 1) {
        musicVolRampRef.current = requestAnimationFrame(step);
      } else {
        musicVolRampRef.current = null;
      }
    };
    musicVolRampRef.current = requestAnimationFrame(step);
  };

  // Route the DJ voice element through our AudioContext so its live RMS can drive the glow while
  // it speaks. Needs the context that ensureGlowAnalyser() built (created when music first plays);
  // if it isn't there yet we leave the voice on its normal output (still audible) and skip the tap.
  // Returns a teardown that stops the analysis and frees the nodes.
  const attachSpeechToGlow = (el: HTMLMediaElement): (() => void) => {
    const ctx = audioCtxRef.current;
    if (!ctx) return () => {};
    try {
      const src = ctx.createMediaElementSource(el);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      src.connect(ctx.destination); // keep the DJ audible through the same context
      const data = new Uint8Array(analyser.fftSize);
      let raf = requestAnimationFrame(function loop() {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        speechRmsRef.current = Math.sqrt(sum / data.length); // 0..1 voice loudness
        raf = requestAnimationFrame(loop);
      });
      return () => {
        cancelAnimationFrame(raf);
        speechRmsRef.current = 0;
        try {
          src.disconnect();
          analyser.disconnect();
        } catch {
          /* already gone */
        }
      };
    } catch {
      return () => {};
    }
  };

  // Hybrid audio-reactive glow:
  //   • base layer follows overall loudness (rms) so the WHOLE song — vocals included — makes
  //     the light rise and fall; an AGC (adaptive peak) keeps loud & quiet songs in the same
  //     range so it never just pins to full;
  //   • a punch layer adds a transient kick on each bass onset on top of that base;
  //   • when the DJ speaks, its voice RMS feeds the same base — and since the music is ducked
  //     under the DJ, the voice naturally becomes what drives the glow.
  // When nothing plays it eases back to a calm resting level (no idle flicker).
  useEffect(() => {
    const REST = 0.42;
    const root = document.documentElement;
    let raf = 0;
    const tick = () => {
      let target = REST;
      const audio = audioRef.current;
      const f = meydaFeatRef.current;
      let musicNorm = 0;
      let punch = 0;
      if (f && audio && !audio.paused) {
        // 1) Overall loudness → base glow. AGC: peak rises instantly, decays slowly, so the
        // normalised level always uses the full range instead of saturating.
        const overall = f.rms || 0;
        glowPeakRef.current = Math.max(overall, glowPeakRef.current * 0.997, 0.03);
        musicNorm = Math.min(1, overall / glowPeakRef.current);
        // 2) Bass/kick onset → punch. Sum the lowest bark bands, react to the rise above their
        // slow baseline, and AGC-normalise that rise so kicks read the same loud or quiet.
        const spec: Float32Array | undefined = f.loudness?.specific;
        const bass = spec ? spec[0] + spec[1] + spec[2] : 0;
        const rise = Math.max(0, bass - glowBaseRef.current);
        glowBaseRef.current += (bass - glowBaseRef.current) * 0.1;
        glowBassPeakRef.current = Math.max(rise, glowBassPeakRef.current * 0.99, 0.001);
        punch = Math.min(1, rise / glowBassPeakRef.current);
      }
      // 3) DJ voice → base glow (AGC-normalised like the music). Drives the light on its own when
      // the music is ducked under it, so the panel "talks" with the DJ.
      const sp = speechRmsRef.current;
      glowSpeechPeakRef.current = Math.max(sp, glowSpeechPeakRef.current * 0.995, 0.02);
      const speechNorm = sp > 0.002 ? Math.min(1, sp / glowSpeechPeakRef.current) : 0;
      const baseNorm = Math.max(musicNorm, speechNorm);
      if (baseNorm > 0 || punch > 0) {
        // Base loudness glow (music vocals / DJ voice) + kick punch — peaks comfortably below "full".
        target = 0.3 + baseNorm * 0.38 + punch * 0.22;
      }
      // Fast attack, slow release → beats snap bright then ease back down, like a real pulse.
      const k = target > glowValRef.current ? 0.35 : 0.1;
      glowValRef.current += (target - glowValRef.current) * k;
      const v = Math.min(0.95, Math.max(0.15, glowValRef.current));
      root.style.setProperty('--glow-pulse', v.toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Tear down the audio graph on unmount.
  useEffect(
    () => () => {
      try {
        speechDetachRef.current();
      } catch {
        /* already detached */
      }
      try {
        meydaRef.current?.stop?.();
      } catch {
        /* already stopped */
      }
      try {
        audioCtxRef.current?.close?.();
      } catch {
        /* already closed */
      }
    },
    [],
  );

  // Speech Voices Setup
  useEffect(() => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      const loadVoices = () => {
        window.speechSynthesis.getVoices();
        setSpeechVoicesLoaded(true);
      };
      loadVoices();
      window.speechSynthesis.onvoiceschanged = loadVoices;
    }
  }, []);

  // Fetch configuration & music taste on startup
  useEffect(() => {
    fetch('/api/config')
      .then((res) => {
        if (res.ok) return res.json();
        throw new Error('fail');
      })
      .then((data) => {
        if (data) setConfigState(data);
        // 默认 FM 模式：服务端 config.fm.default（← config.json / FM_DEFAULT）为 true 时，app 启动即开私人 FM
        // 单曲流。只在首次加载触发一次（fmAutoStartedRef 防抖），之后用户的开/关一律为准。开 FM 会让
        // /api/tracks 灌进来的大队列不再覆盖播放器（见下方 fetch("/api/tracks")）。
        if (data?.fm?.default && !fmAutoStartedRef.current) {
          fmAutoStartedRef.current = true;
          pendingFmPausedRef.current = true; // 默认进 FM，但 cue 好后停在暂停态，不自动播
          setPersonalFm(true);
        }
      })
      .catch((err) => console.log('Failed to load configuration:', err));

    fetch('/api/taste')
      .then((res) => {
        if (res.ok) return res.json();
        throw new Error('fail');
      })
      .then((data) => {
        if (data && data.taste) setTasteState(data.taste);
      })
      .catch((err) => console.log('Failed to load music taste profile:', err));

    // Restore UI preferences (theme, clock font) so a refresh keeps the user's last choices.
    fetch('/api/preferences')
      .then((res) => {
        if (res.ok) return res.json();
        throw new Error('fail');
      })
      .then((data) => {
        if (data?.theme === 'light' || data?.theme === 'dark') setColorMode(data.theme);
        if (Number.isInteger(data?.clockFontIdx)) setClockFontIdx(data.clockFontIdx);
      })
      .catch((err) => console.log('Failed to load preferences:', err))
      .finally(() => {
        prefsLoadedRef.current = true;
      });
  }, []);

  // Persist UI preferences whenever the theme or clock font changes — but only after the initial
  // load, so the default state doesn't clobber the stored values on first paint.
  useEffect(() => {
    if (!prefsLoadedRef.current) return;
    fetch('/api/preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: colorMode, clockFontIdx }),
    }).catch((err) => console.log('Failed to save preferences:', err));
  }, [colorMode, clockFontIdx]);

  // Show the首登引导 card only when a profile has never been generated/skipped (Module A
  // state machine: none/prompted → prompt; skipped/ready/generating → no auto-prompt, D-02).
  useEffect(() => {
    if (!userSession.isLoggedIn) {
      setShowTastePrompt(false);
      return;
    }
    fetch('/api/taste/state')
      .then((res) => (res.ok ? res.json() : null))
      .then((state) => {
        const status = state?.status;
        setShowTastePrompt(status === 'none' || status === 'prompted' || status == null);
      })
      .catch(() => setShowTastePrompt(true));
  }, [userSession.isLoggedIn]);

  // Safeguard: Prevent QR Code login modal from reopening when already logged in
  useEffect(() => {
    if (userSession.isLoggedIn) {
      setShowQrModal(false);
      setIsCheckingQr(false);
    }
  }, [userSession.isLoggedIn]);

  // Load persistent chat history on startup — only the latest page (older pages load on demand
  // via the "load earlier" control). Server returns { messages, hasMore }.
  useEffect(() => {
    fetch('/api/chat/history')
      .then((res) => {
        if (res.ok) return res.json();
        throw new Error('history fetch fail');
      })
      .then((data) => {
        const list: Message[] = Array.isArray(data) ? data : data?.messages || [];
        if (list.length > 0) {
          setHasMoreHistory(Array.isArray(data) ? false : !!data?.hasMore);
          forceScrollRef.current = true; // land at the newest message on open
          setMessages(list);
        } else {
          // If no history exists, seed a simple, warm greeting.
          const greetingText = `Hey, I'm Claudio. What do you feel like listening to today?`;

          setMessages([
            {
              id: 'initial-claudio',
              sender: 'claudio',
              text: greetingText,
              timestamp: formatLocalTime(new Date()),
              avatarUrl: claudioAvatar,
            },
          ]);
        }
      })
      .catch((err) => {
        console.warn('Could not fetch chat history, seeding fresh greeting:', err);
      });
  }, []);

  // Fetch the page of older messages preceding the oldest one currently shown, and prepend them —
  // preserving the scroll position so the viewport doesn't jump when content is added above.
  const loadEarlierMessages = async () => {
    if (loadingEarlier || messages.length === 0) return;
    const oldestId = messages[0]?.id;
    if (!oldestId) return;
    setLoadingEarlier(true);
    const feed = chatFeedRef.current;
    const prevHeight = feed?.scrollHeight ?? 0;
    const prevTop = feed?.scrollTop ?? 0;
    try {
      const res = await fetch(`/api/chat/history?before=${encodeURIComponent(oldestId)}`);
      if (res.ok) {
        const data = await res.json();
        const older: Message[] = data?.messages || [];
        if (older.length) {
          setHasMoreHistory(!!data.hasMore);
          setMessages((prev) => [...older, ...prev]);
          setVisibleCount((v) => v + older.length); // reveal the page we just prepended
          requestAnimationFrame(() => {
            const f = chatFeedRef.current;
            if (f) f.scrollTop = f.scrollHeight - prevHeight + prevTop;
          });
        } else {
          setHasMoreHistory(false);
        }
      }
    } catch (err) {
      console.warn('load earlier failed', err);
    } finally {
      setLoadingEarlier(false);
    }
  };

  // Auto scroll chat — only when the user is already near the bottom (so reading older broadcasts
  // isn't yanked down), OR when forceScrollRef is set (right after sending, to reveal the new reply).
  useEffect(() => {
    const feed = chatFeedRef.current;
    if (!feed) return;
    const distanceFromBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight;
    const isNearBottom = distanceFromBottom < 120;
    const lastMsg = messages[messages.length - 1];
    const isStreamingReply = !!lastMsg && (lastMsg as Message).streaming === true;
    if (forceScrollRef.current) {
      forceScrollRef.current = false;
      // Jump (no smooth) on the forced case so a long just-sent turn lands at the bottom immediately.
      feed.scrollTop = feed.scrollHeight;
    } else if (isStreamingReply) {
      // Follow an in-flight reply to the bottom even when it lands in one big chunk (e.g. a config-error
      // notice arrives whole, not token-by-token). A single large delta would otherwise jump past the
      // near-bottom threshold, the follow logic would disengage, and the rest of the message would stay
      // hidden below the fold.
      feed.scrollTop = feed.scrollHeight;
    } else if (isNearBottom) {
      // Scroll only the feed itself — NOT scrollIntoView, which would also scroll
      // the (programmatically scrollable) overflow-hidden ancestors and push the header off-screen.
      feed.scrollTo({ top: feed.scrollHeight, behavior: 'smooth' });
    }
  }, [messages, isTyping]);

  // Return keyboard focus to the chat input. wired-input (light theme) keeps its real <input> in
  // shadow DOM, so reach through to it; the dark-theme input is a plain native element.
  const focusChatInput = () => {
    const el = document.getElementById('chat-text-input') as any;
    if (!el) return;
    const inner = el.shadowRoot?.querySelector('input, textarea');
    (inner || el).focus?.();
  };

  // On first entering the app, put the cursor in the chat input so the listener can type to the DJ
  // right away. The light-theme wired-input renders its real <input> into shadow DOM asynchronously
  // (Lit), so it may not exist on the first frame — retry across a few frames until focus lands.
  useEffect(() => {
    let tries = 0;
    let raf = 0;
    const tryFocus = () => {
      focusChatInput();
      const el = document.getElementById('chat-text-input') as any;
      const inner = el?.shadowRoot?.querySelector('input, textarea');
      const focused =
        document.activeElement === el || (inner && el?.shadowRoot?.activeElement === inner);
      if (!focused && tries++ < 10) raf = requestAnimationFrame(tryFocus);
    };
    tryFocus();
    return () => cancelAnimationFrame(raf);
  }, []);

  // Keep the chat input focused across a send: it's briefly disabled while Claudio "types", which
  // drops focus — hand it back the instant the field re-enables so the listener can keep typing
  // without clicking back in.
  const wasTypingRef = useRef(false);
  useEffect(() => {
    if (wasTypingRef.current && !isTyping) focusChatInput();
    wasTypingRef.current = isTyping;
  }, [isTyping]);

  // Global hand-drawn decorator: in the light "sketch" theme, trace rough.js strokes over the
  // live DOM so every visible element reads as sketched, not just the <RoughOverlay> surfaces.
  //   • form controls (button/input/textarea) + [data-sketch-box] → rough box, or ellipse when
  //     ~square & round, or a scribbled track line for range sliders
  //   • [data-sketch-line="top|bottom|left|right|vertical"] → a single rough rule replacing a
  //     crisp CSS border / divider
  // Each overlay lives in the element's parent (so it works for replaced <input>/<textarea> too)
  // and is positioned via the element's offset box. Re-runs when the on-screen set changes; a
  // per-element ResizeObserver keeps every stroke fitted through layout shifts.
  // useLayoutEffect (not useEffect): the strokes must be drawn before the browser paints. On a
  // dark→light switch CSS hides the crisp borders immediately while the rough.js strokes would draw
  // a frame later — controls flash borderless, then the strokes pop in. Drawing synchronously here
  // (and inside switchTheme's flushSync) means the light theme's first painted frame already has them.
  useLayoutEffect(() => {
    if (colorMode !== 'light') return;
    const root = rootRef.current;
    if (!root) return;

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const cleanups: Array<() => void> = [];
    // Every element's draw() is registered here so a global layout shift (window resize, panel
    // toggle that moves but doesn't resize an element) can re-fit every stroke — the per-element
    // ResizeObserver only fires on the element's own size change, not when it merely moves.
    // Each tracked element exposes a sync() that re-fits its stroke to the element's *current*
    // offset box. They're all driven by one rAF loop (below) so any layout shift — window resize,
    // panel toggle, content reflow that merely *moves* the element — keeps the stroke glued on,
    // not just changes to the element's own size (which a ResizeObserver alone would miss).
    const syncs: Array<() => void> = [];

    // Shared setup: park an absolutely-positioned SVG in the element's parent and keep it sized and
    // positioned over the element, with `build` supplying the rough node for the current geometry.
    const attach = (
      el: HTMLElement,
      seed: number,
      build: (
        rc: ReturnType<typeof rough.svg>,
        w: number,
        h: number,
        opts: any,
      ) => SVGGElement | undefined,
    ) => {
      const host = el.parentElement;
      if (!host) return;
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';

      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('aria-hidden', 'true');
      svg.style.position = 'absolute';
      svg.style.overflow = 'visible';
      svg.style.pointerEvents = 'none';
      svg.style.zIndex = '0';
      host.appendChild(svg);

      const stroke = el.getAttribute('data-sketch-stroke') || '#c0763a';
      let lastL = NaN,
        lastT = NaN,
        lastW = NaN,
        lastH = NaN;
      const sync = () => {
        const w = el.offsetWidth,
          h = el.offsetHeight;
        const l = el.offsetLeft,
          t = el.offsetTop;
        if (w < 1 || h < 1) return;
        if (l === lastL && t === lastT && w === lastW && h === lastH) return; // unchanged
        const sizeChanged = w !== lastW || h !== lastH;
        lastL = l;
        lastT = t;
        lastW = w;
        lastH = h;
        svg.style.left = `${l}px`;
        svg.style.top = `${t}px`;
        if (!sizeChanged) return; // moved only — repositioning the SVG above is enough
        svg.setAttribute('width', String(w));
        svg.setAttribute('height', String(h));
        while (svg.firstChild) svg.removeChild(svg.firstChild);
        const rc = rough.svg(svg);
        const opts = { stroke, strokeWidth: 1.6, roughness: 2.2, bowing: 1.9, seed };
        const node = build(rc, w, h, opts);
        if (node) svg.appendChild(node);
      };

      sync();
      syncs.push(sync);
      cleanups.push(() => svg.remove());
    };

    // Boxes: controls + opt-in [data-sketch-box] (e.g. avatars).
    const boxes = (
      Array.from(
        root.querySelectorAll('button, input, textarea, [data-sketch-box]'),
      ) as HTMLElement[]
    ).filter((el) => !el.hasAttribute('data-no-sketch'));

    boxes.forEach((el, i) => {
      const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
      const isRange = el instanceof HTMLInputElement && el.type === 'range';
      attach(el, ((i * 9277) % 1999) + 1, (rc, w, h, opts) => {
        const pad = 3;
        if (isRange) return rc.line(pad, h / 2, w - pad, h / 2, { ...opts, strokeWidth: 2 });
        const fullyRound = radius >= Math.min(w, h) / 2 - 2;
        return fullyRound && Math.abs(w - h) <= 6
          ? rc.ellipse(w / 2, h / 2, w - pad, h - pad, opts)
          : rc.rectangle(pad, pad, w - pad * 2, h - pad * 2, opts);
      });
    });

    // Lines: replace crisp CSS borders / dividers with a rough rule on each named edge. The
    // attribute may list several sides comma-separated (e.g. "top,bottom") to sketch more than one.
    const lines = Array.from(root.querySelectorAll('[data-sketch-line]')) as HTMLElement[];
    lines.forEach((el, i) => {
      const sides = (el.getAttribute('data-sketch-line') || 'bottom')
        .split(',')
        .map((s) => s.trim());
      attach(el, ((i * 4111) % 1999) + 1, (rc, w, h, opts) => {
        const p = 2;
        const drawSide = (side: string) => {
          if (side === 'top') return rc.line(p, p, w - p, p, opts);
          if (side === 'left') return rc.line(p, p, p, h - p, opts);
          if (side === 'right') return rc.line(w - p, p, w - p, h - p, opts);
          if (side === 'vertical') return rc.line(w / 2, p, w / 2, h - p, opts);
          return rc.line(p, h - p, w - p, h - p, opts); // bottom
        };
        if (sides.length === 1) return drawSide(sides[0]);
        const g = document.createElementNS(SVG_NS, 'g');
        sides.forEach((s) => {
          const n = drawSide(s);
          if (n) g.appendChild(n);
        });
        return g;
      });
    });

    // Single rAF loop drives every stroke. Each sync() is a no-op unless its element's offset box
    // actually changed, so this stays cheap (a few offset reads per frame) while guaranteeing the
    // strokes track the live layout through any reflow, resize, or panel toggle.
    let raf = 0;
    const tick = () => {
      for (const s of syncs) s();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    cleanups.push(() => cancelAnimationFrame(raf));

    return () => cleanups.forEach((c) => c());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    colorMode,
    chatMaximized,
    messages,
    isTyping,
    showQueue,
    showConfigModal,
    showQrModal,
    showTastePrompt,
    speechError,
    userSession.isLoggedIn,
  ]);

  // Utility to format clock hours and minutes cleanly
  const formatTimeHoursMinutes = (date: Date) => {
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${hours}:${minutes}`;
  };

  const formatTimeSeconds = (date: Date) => {
    return date.getSeconds().toString().padStart(2, '0');
  };

  const formatLocalDate = (date: Date) => {
    return date
      .toLocaleDateString('en-US', {
        weekday: 'long',
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      })
      .toUpperCase();
  };

  const formatLocalTime = (date: Date) => {
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  };

  const formatDuration = (secondsNum: number) => {
    const mins = Math.floor(secondsNum / 60);
    const secs = Math.floor(secondsNum % 60)
      .toString()
      .padStart(2, '0');
    return `${mins}:${secs}`;
  };

  // Music Player Actions
  const handlePlayPause = () => {
    setIsPlaying(!isPlaying);
  };

  // Spacebar toggles play/pause globally — except while typing, so it can't hijack the chat
  // input, the cookie/QR fields, or the light-theme wired text controls (whose real <input> lives
  // in shadow DOM and surfaces here as the custom element tag, e.g. WIRED-INPUT/WIRED-TEXTAREA).
  // Buttons (native + wired) are deliberately NOT skipped: after a click they keep focus, and we
  // want Space to still control playback then. We preventDefault so that Space also doesn't fire
  // the focused button's native activation (which would otherwise re-trigger the just-clicked one).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' && e.key !== ' ') return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'WIRED-INPUT' ||
        tag === 'WIRED-TEXTAREA' ||
        t?.isContentEditable
      )
        return;
      e.preventDefault();
      setIsPlaying((p) => !p);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const handleStop = () => {
    setIsPlaying(false);
    if (audioRef.current) {
      audioRef.current.currentTime = 0;
      setAudioProgress(0);
    }
  };

  // Replay a past DJ turn's committed playlist: load it as the live queue and start from the top.
  // Same effect as that turn's original "set" — lets the user re-launch any earlier playlist.
  const handlePlayQueue = (queue: Track[]) => {
    if (!queue || queue.length === 0) return;
    addSystemLog(`Replaying a ${queue.length}-song playlist from chat. On air.`);
    setPersonalFm(false); // 换上一整单 → 关掉私人 FM 续流
    setTracks(queue);
    setCurrentTrackIndex(0);
    setAudioProgress(0);
    setIsPlaying(true);
  };

  const handleNextTrack = () => {
    // 私人 FM 时切歌 = 拉下一首 FM（队列只有当前一首，没有「下一首」可跳）。
    if (personalFmRef.current) {
      fetchFmRef.current();
      return;
    }
    let nextIndex = currentTrackIndex + 1;
    if (nextIndex >= tracks.length) {
      nextIndex = 0;
    }
    setCurrentTrackIndex(nextIndex);
    setAudioProgress(0);
    setIsPlaying(true);

    // Announce the song transition dynamically in client log
    const nextSong = tracks[nextIndex];
    addSystemLog(`DJ transitioning to track: "${nextSong.title}" inside "${nextSong.album}"`);
  };

  const handlePrevTrack = () => {
    // 私人 FM 是单向流，没有「上一首」——上一首键同样拉一首新 FM。
    if (personalFmRef.current) {
      fetchFmRef.current();
      return;
    }
    let prevIndex = currentTrackIndex - 1;
    if (prevIndex < 0) {
      prevIndex = tracks.length - 1;
    }
    setCurrentTrackIndex(prevIndex);
    setAudioProgress(0);
    setIsPlaying(true);

    const prevSong = tracks[prevIndex];
    addSystemLog(`DJ transitioning to track: "${prevSong.title}" inside "${prevSong.album}"`);
  };

  // 私人 FM：拉【一首】下一曲，整单替换成这一首并立刻从头播 —— FM 时队列永远只有当前这一首。
  // 播完（或点切歌）会再被调用一次，如此循环成「不断的流」。fetchingFmRef 防止并发重复拉取。
  const personalFmRef = useRef(personalFm);
  useEffect(() => {
    personalFmRef.current = personalFm;
  }, [personalFm]);
  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);
  // Live mirror of the queue length so the personal_fm op handler (a stale closure captured at send
  // time) can tell a real single-track FM stream (length 1) from an incoherent FM-on + big-queue.
  const tracksRef = useRef(tracks);
  useEffect(() => {
    tracksRef.current = tracks;
  }, [tracks]);
  const fetchingFmRef = useRef(false);
  // autoplay=false 时只把这首 FM 单曲【装进队列、cue 好】但保持暂停 —— 给「默认 FM 但别自动播」用：
  // 启动时浏览器本就禁止自动播放，与其放一首会被拦下的歌，不如明确停在暂停态，等用户按播放。
  const fetchAndPlayNextFm = async (autoplay: boolean = true) => {
    if (fetchingFmRef.current) return;
    fetchingFmRef.current = true;
    try {
      const resp = await fetch('/api/personal-fm/next');
      if (!resp.ok) {
        addSystemLog('私人 FM 拿不到下一首（可能未登录或风控），已关闭 FM。');
        setPersonalFm(false);
        return;
      }
      const data = await resp.json();
      const track: Track = data?.track;
      if (!track) return;
      setTracks([track]); // FM 队列只保留当前这一首
      setCurrentTrackIndex(0);
      setAudioProgress(0);
      setIsPlaying(autoplay);
      addSystemLog(
        `私人 FM ▸ "${track.title}" — ${track.artist}${autoplay ? '' : '（Ready, Tap to Play!）'}`,
      );
    } catch (err) {
      console.warn('personal FM fetch failed:', err);
    } finally {
      fetchingFmRef.current = false;
    }
  };
  // Keep a stable ref to the latest fetcher so audio-event closures always call the current one.
  const fetchFmRef = useRef(fetchAndPlayNextFm);
  fetchFmRef.current = fetchAndPlayNextFm;

  // Toggling personal FM ON kicks off the stream right away (grab one song and play it).
  // Turning it off just stops the auto-continue; whatever is playing keeps playing.
  // 例外：config 默认拉起的那次（pendingFmPausedRef）只 cue 不播 —— 默认 FM 模式但停在暂停态。
  const prevPersonalFmRef = useRef(personalFm);
  useEffect(() => {
    const was = prevPersonalFmRef.current;
    prevPersonalFmRef.current = personalFm;
    if (personalFm && !was) {
      const paused = pendingFmPausedRef.current;
      pendingFmPausedRef.current = false;
      fetchFmRef.current(!paused);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personalFm]);

  const toggleMute = () => {
    const newMuted = !isMuted;
    setIsMuted(newMuted);
    if (audioRef.current) {
      audioRef.current.volume = newMuted ? 0 : volume;
    }
  };

  // 当前歌切换时，查它是不是网易云红心歌，用来点亮红心按钮。未登录则恒为 false。
  useEffect(() => {
    const t = tracks[currentTrackIndex];
    if (!t || !userSession.isLoggedIn) {
      setActiveTrackLiked(false);
      return;
    }
    let cancelled = false;
    const sid = String(t.id).replace(/^netease-/, '');
    fetch(`/api/song/liked?id=${encodeURIComponent(sid)}`)
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setActiveTrackLiked(!!d.liked);
      })
      .catch(() => {
        if (!cancelled) setActiveTrackLiked(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTrackIndex, tracks[currentTrackIndex]?.id, userSession.isLoggedIn]);

  // 点红心：已是红心→取消，否则→标记。乐观更新，失败回滚。
  const toggleNeteaseLike = async () => {
    const t = tracks[currentTrackIndex];
    if (!t || likeBusy) return;
    if (!userSession.isLoggedIn) {
      addSystemLog('Login to Netease first to like songs.');
      return;
    }
    const sid = String(t.id).replace(/^netease-/, '');
    const next = !activeTrackLiked;
    setActiveTrackLiked(next);
    setLikeBusy(true);
    try {
      const res = await fetch('/api/song/like', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: sid, like: next }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'like failed');
      setActiveTrackLiked(!!data.liked);
    } catch (err: any) {
      setActiveTrackLiked(!next); // 回滚
      addSystemLog(`Failed to ${next ? 'like' : 'unlike'} song: ${err.message}`);
    } finally {
      setLikeBusy(false);
    }
  };

  const addSystemLog = (text: string) => {
    setMessages((prev) => [
      ...prev,
      {
        id: Math.random().toString(),
        sender: 'system',
        text,
        timestamp: formatLocalTime(new Date()),
      },
    ]);
  };

  // Append a Claudio chat bubble AND persist it to chat history (reloads next open). Used for the 串词
  // so it just reads as Claudio talking in the feed — no special log styling.
  const addClaudioNote = (text: string) => {
    const msg = {
      id: Math.random().toString(),
      sender: 'claudio' as const,
      text,
      timestamp: formatLocalTime(new Date()),
      avatarUrl: claudioAvatar,
    };
    forceScrollRef.current = true; // 新串词出现时把聊天窗滚到底，露出这条新消息
    setMessages((prev) => [...prev, msg]);
    fetch('/api/chat/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg),
    }).catch(() => {
      /* best-effort; the bubble still shows this session */
    });
  };

  // Cookie login: log in on the official web page (music.163.com), then paste the cookie
  // (at least MUSIC_U=...). Bypasses QR scanning / its risk-control cooldown.
  const handleCookieLogin = async () => {
    if (!cookieInput.trim()) return;
    setCookieLoggingIn(true);
    setQrStatusText('Validating cookie...');
    try {
      const res = await fetch('/api/login/cookie', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookie: cookieInput.trim() }),
      });
      const data = await res.json();
      if (res.ok && data.isLoggedIn) {
        setIsCheckingQr(false);
        setShowQrModal(false);
        setCookieInput('');
        const sessionRes = await fetch('/api/user/session');
        if (sessionRes.ok) {
          const sessData = await sessionRes.json();
          if (sessData.isLoggedIn) {
            setUserSession(sessData);
            addSystemLog(`DJ Sync: Welcome ${sessData.nickname}! Logged in via cookie.`);
          }
        }
      } else {
        throw new Error(data.error || 'Cookie login failed');
      }
    } catch (err: any) {
      console.error('Cookie login failed:', err);
      setQrStatusText(`Cookie 登录失败: ${err.message}`);
    } finally {
      setCookieLoggingIn(false);
    }
  };

  // Netease QR-code Login Initiation Action
  const handleOpenLogin = async () => {
    setShowQrModal(true);
    // Already logged in: the modal shows the account panel + LOGOUT, no QR needed.
    if (userSession.isLoggedIn) return;
    setQrImg(null);
    setQrStatusText('Generating secure QR Code from Netease Cloud Music...');
    try {
      const keyRes = await fetch('/api/login/qr/key');
      const keyData = await keyRes.json();
      if (!keyData.key) {
        throw new Error('Failed to load secure login key');
      }
      const key = keyData.key;
      setQrKey(key);

      const createRes = await fetch(`/api/login/qr/create?key=${encodeURIComponent(key)}`);
      const createData = await createRes.json();
      if (!createData.qrimg) {
        throw new Error('Failed to render QR base64 code image');
      }
      setQrImg(createData.qrimg);
      setQrStatusText('Open Netease Cloud Music App, scan code to authenticate.');
      setIsCheckingQr(true);
    } catch (error: any) {
      console.error('Error setting up login QR:', error);
      setQrStatusText(`Failed to load login QR: ${error.message}`);
    }
  };

  // Netease Logout Action
  const handleLogout = async () => {
    try {
      const res = await fetch('/api/user/logout', { method: 'POST' });
      if (res.ok) {
        setUserSession({ isLoggedIn: false });
        addSystemLog('Successfully signed out of Netease Cloud Music.');

        // Reload default curated playlist tracks
        const tracksRes = await fetch('/api/tracks');
        if (tracksRes.ok) {
          const defaultTracks = await tracksRes.json();
          setTracks(defaultTracks);
          setCurrentTrackIndex(0);
        }
      }
    } catch (error) {
      console.error('Netease sign out request failed:', error);
    }
  };

  // QR Code auth status check poll
  useEffect(() => {
    let timerId: any = null;
    let hasFinished = false;

    if (isCheckingQr && qrKey && showQrModal) {
      const checkStatus = async () => {
        if (hasFinished) return;
        try {
          const checkRes = await fetch(`/api/login/qr/check?key=${encodeURIComponent(qrKey)}`);
          if (!checkRes.ok) return;
          if (hasFinished) return;
          const data = await checkRes.json();

          if (data.code === 800) {
            hasFinished = true;
            if (timerId) clearInterval(timerId);
            setQrStatusText('QR Code expired. Refreshing...');
            setIsCheckingQr(false);
            handleOpenLogin();
          } else if (data.code === 801) {
            setQrStatusText('Waiting for Netease Cloud Music App scan...');
          } else if (data.code === 802) {
            setQrStatusText('Scanned! Confirm the Authorization on your phone App.');
          } else if (data.code === 803) {
            hasFinished = true;
            if (timerId) clearInterval(timerId);
            setQrStatusText('Authorized! Loading profile and importing heart playlist...');
            setIsCheckingQr(false);
            setShowQrModal(false);

            // Fetch the fully synced user session
            const sessionRes = await fetch('/api/user/session');
            if (sessionRes.ok) {
              const sessData = await sessionRes.json();
              if (sessData.isLoggedIn) {
                setUserSession(sessData);
                addSystemLog(
                  `DJ Sync: Welcome ${sessData.nickname}! Successfully synced your Netease red-heart playlist.`,
                );

                // Track reload occurs automatically through userSession.isLoggedIn dependency array!
              }
            }
          }
        } catch (err) {
          console.error('Status polling check failed:', err);
        }
      };

      timerId = setInterval(checkStatus, 3000);
    }

    return () => {
      hasFinished = true;
      if (timerId) clearInterval(timerId);
    };
  }, [isCheckingQr, qrKey, showQrModal]);

  const playLocalSpeechSynthesisFallback = (
    messageId: string,
    textToSpeak: string,
    onEnded?: () => void,
  ) => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(textToSpeak);
      const voices = window.speechSynthesis.getVoices();
      // The configured Doubao voice is MALE; this native-synth path only runs as a *fallback* when
      // Doubao TTS fails. The old code grabbed the first `en` voice (often a female default like
      // Samantha) and read Chinese with an English voice → "怎么变女声了". Match the text's language and
      // prefer a male voice, explicitly skipping known female system voices.
      const isZh = /[一-鿿]/.test(textToSpeak);
      const FEMALE =
        /(female|samantha|victoria|karen|moira|tessa|fiona|ting-?ting|sin-?ji|mei-?jia|zira|susan|catherine|hazel|amelie|google 国语|google 中文)/i;
      const MALE =
        /(\bmale\b|kangkang|yunyang|fred|alex|daniel|aaron|rishi|diego|jorge|thomas|liang|yunxi)/i;
      const byLang = voices.filter((v) => v.lang.toLowerCase().startsWith(isZh ? 'zh' : 'en'));
      const pool = byLang.length ? byLang : voices;
      const pick =
        pool.find((v) => MALE.test(v.name) && !FEMALE.test(v.name)) || // a real male voice
        pool.find((v) => !FEMALE.test(v.name)) || // at least not a known female one
        pool[0]; // last resort (platform may ship only female)

      if (pick) utterance.voice = pick;
      utterance.lang = pick?.lang || (isZh ? 'zh-CN' : 'en-US');
      utterance.rate = 0.95;
      utterance.pitch = 0.9;

      utterance.onstart = () => {
        setCurrentlySpeakingId(messageId);
      };
      utterance.onend = () => {
        setCurrentlySpeakingId(null);
        if (onEnded) onEnded();
      };
      utterance.onerror = () => {
        setCurrentlySpeakingId(null);
        if (onEnded) onEnded();
      };
      window.speechSynthesis.speak(utterance);
    } else {
      alert('Audio speech synthesis is not supported on this device/frame.');
      if (onEnded) onEnded();
    }
  };

  // Speaking voice / Replay TTS Action
  const handleSpeechReplay = async (
    messageId: string,
    textToSpeak: string,
    onEnded?: () => void,
  ) => {
    if (currentlySpeakingId === messageId) {
      if (speechAudioRef.current) {
        speechAudioRef.current.pause();
      }
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
      setCurrentlySpeakingId(null);
      return;
    }

    if (speechAudioRef.current) {
      speechAudioRef.current.pause();
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }

    // Check Volcengine Doubao TTS SSE voice credentials
    const hasDoubaoTTS = configState?.tts?.apiKey && configState?.tts?.resourceId;
    if (hasDoubaoTTS) {
      setCurrentlySpeakingId(messageId);
      try {
        const audioUrl = `/api/tts?text=${encodeURIComponent(textToSpeak)}`;
        const audio = new Audio(audioUrl);
        speechAudioRef.current = audio;
        audio.onended = () => {
          setCurrentlySpeakingId(null);
          if (onEnded) onEnded();
        };
        audio.onerror = (e) => {
          console.error('Doubao TTS synthesis playback error details:', e);
          addSystemLog(
            'Doubao TTS playback failed. Falling back to native system speech synthesizer...',
          );
          playLocalSpeechSynthesisFallback(messageId, textToSpeak, onEnded);
        };
        await audio.play();
      } catch (err) {
        console.error('Doubao Play failed:', err);
        addSystemLog(
          'Doubao TTS execution crashed. Falling back to native system speech synthesizer...',
        );
        playLocalSpeechSynthesisFallback(messageId, textToSpeak, onEnded);
      }
    } else {
      // Fallback local synthesis
      playLocalSpeechSynthesisFallback(messageId, textToSpeak, onEnded);
    }
  };

  // Strip inline [emotion] tags / join {text} fields into plain text for the DJ NOTE display.
  const scriptToPlainText = (script: any): string => {
    if (!Array.isArray(script)) return '';
    return script
      .map((x: any) =>
        typeof x === 'string' ? x.replace(/\[[^\]]*\]/g, '').trim() : x?.text || '',
      )
      .join(' ')
      .trim();
  };

  // Speak ONE narration over the music with ducking (SPEC 播放契约): music keeps playing at
  // reduced volume while the DJ speaks, restored when done. Spoken ONCE per playlist update
  // (选完歌单串一次) — NOT per song, so skipping/advancing tracks never re-triggers TTS.
  // Missing/failed narration must NOT block or pause the music (B-R7 degrade rule).
  const speakNarration = async (script: any, speakingTrackId?: string) => {
    if (!script) return;
    // Lift the music back to full over ~1s (gradual fade-up after the DJ).
    const restoreVolume = () => {
      duckMusicTo(1, 1000);
    };
    try {
      const resp = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ script }),
      });
      if (!resp.ok) {
        restoreVolume();
        return;
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);

      if (speechAudioRef.current) speechAudioRef.current.pause();
      speechDetachRef.current(); // detach any previous DJ→glow tap
      const a = new Audio(url);
      speechAudioRef.current = a;
      const cleanup = () => {
        speechDetachRef.current(); // stop feeding the glow from the (now finished) voice
        speechDetachRef.current = () => {};
        restoreVolume(); // ~1s fade-up back to the song
        setCurrentlySpeakingId(null);
        URL.revokeObjectURL(url);
      };
      a.onended = cleanup;
      a.onerror = cleanup;
      // 1) Duck the music down over ~1s BEFORE the DJ comes in.
      duckMusicTo(0.22, 1000);
      if (speakingTrackId) setCurrentlySpeakingId(speakingTrackId);
      // 2) Let the duck settle (~0.9s) so the song is already quiet when the DJ enters.
      await new Promise((r) => setTimeout(r, 900));
      // 3) Tap the voice so it drives the glow, then bring the DJ in — unless the user paused during
      //    the pre-roll. If paused, leave it cued; the isPlaying pause/resume effect will play it.
      speechDetachRef.current = attachSpeechToGlow(a);
      if (isPlayingRef.current) await a.play();
    } catch (err) {
      console.warn('Narration overlay failed; music continues at full volume:', err);
      speechDetachRef.current();
      speechDetachRef.current = () => {};
      restoreVolume();
    }
  };

  // 逐曲解说 / 串词 (per-song narration): when the narration switch (Settings → TTS) is on, each song
  // that starts playing gets its own 串词 generated fresh at play time (/api/narration) and spoken
  // over the music with ducking. Independent of 私人 FM — it's a TTS preference, not the FM stream.
  const narrationOn = !!configState?.tts?.narration;
  const fmReqRef = useRef(0); // guards against stale narration when the user skips fast
  const fmNarratedRef = useRef<string | null>(null); // last track id narrated, so we don't repeat it

  // Hard-stop any DJ narration in flight — called whenever playback changes out from under it
  // (切歌 / 暂停 / 换播放模式) so the voice never keeps talking over a song that's already gone.
  // Invalidates pending /api/narration fetches (fmReqRef++), kills both the Doubao <audio> and the
  // native speech-synth fallback, drops the DJ→glow tap, and lifts the (maybe still-ducked) music back.
  const stopNarration = () => {
    fmReqRef.current++; // any in-flight narration result is now stale and will be dropped
    if (speechAudioRef.current) {
      try {
        speechAudioRef.current.pause();
      } catch {
        /* already stopped */
      }
      speechAudioRef.current = null;
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window)
      window.speechSynthesis.cancel();
    try {
      speechDetachRef.current();
    } catch {
      /* already detached */
    }
    speechDetachRef.current = () => {};
    setCurrentlySpeakingId(null);
    duckMusicTo(1, 250); // undo any duck so the song isn't left quiet
  };

  useEffect(() => {
    if (!narrationOn) {
      fmNarratedRef.current = null;
      return;
    }
    if (!isPlaying) return;
    const track = tracks[currentTrackIndex];
    if (!track || fmNarratedRef.current === track.id) return;
    fmNarratedRef.current = track.id;

    const reqId = ++fmReqRef.current;
    (async () => {
      try {
        const resp = await fetch('/api/narration', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            song: { id: track.id, title: track.title, artist: track.artist, album: track.album },
            position: currentTrackIndex + 1, // 当前歌在队列中的位置（第几首）
            total: tracks.length,
          }),
        });
        if (!resp.ok) return;
        const data = await resp.json();
        // A newer track may have started while we awaited — drop this now-stale narration.
        if (reqId !== fmReqRef.current) return;
        const storyText = scriptToPlainText(data.script);
        if (storyText) {
          setTracks((prev: Track[]) =>
            prev.map((t: Track) => (t.id === track.id ? { ...t, story: storyText } : t)),
          );
          // 串词作为 Claudio 的一条消息进 feed，并持久化（下次打开还在）。
          addClaudioNote(storyText);
        }
        if (data.script) speakNarration(data.script, track.id);
      } catch (err) {
        console.warn('FM narration failed; music continues:', err);
      }
    })();
    // Key on the current track's id, not just the index: in 私人 FM every 切歌 swaps `tracks` while
    // pinning currentTrackIndex at 0, so an index-only dep would only ever narrate the first FM song.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [narrationOn, isPlaying, currentTrackIndex, tracks[currentTrackIndex]?.id, personalFm]);

  // 硬停：切歌 / 换播放模式 (或关掉解说) 时，把还黏在旧歌上的串词彻底掐掉并解除音乐压低。
  // 故意【不】依赖 isPlaying——暂停不该走这里，暂停只是暂停，见下一个 effect。
  useEffect(() => {
    return () => {
      stopNarration();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTrackIndex, tracks[currentTrackIndex]?.id, personalFm, narrationOn]);

  // 暂停/继续：串词跟着音乐一起停、一起走（不是掐断）。暂停时 DJ 的话停在原处，继续时接着念。
  useEffect(() => {
    const a = speechAudioRef.current;
    if (!a || a.ended) return;
    if (isPlaying)
      a.play().catch(() => {
        /* resumes on the next user gesture if blocked */
      });
    else a.pause();
  }, [isPlaying]);

  // Mirror player state to the server so the agent's get_player_state reads truth (双通道).
  // personalFm is included so a manual FM toggle (button) reaches the agent — otherwise it keeps
  // thinking FM is still running after the user turned it off.
  // queue (tracks) MUST be mirrored too: during personal FM the client swaps `tracks` to each single
  // streamed song, and a manual skip/remove changes it — without this the server's playerState.queue
  // stays frozen on the pre-FM playlist and the agent reasons about the wrong "current song".
  useEffect(() => {
    const status = isPlaying ? 'playing' : audioProgress > 0 ? 'paused' : 'stopped';
    fetch('/api/player/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status,
        currentIndex: currentTrackIndex,
        personalFm,
        narration: narrationOn,
        queue: tracks,
      }),
    }).catch(() => {
      /* best-effort mirror */
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, currentTrackIndex, personalFm, narrationOn, tracks]);

  // Persist the player to localStorage so a refresh resumes the same queue/position/settings
  // (see loadPlayerState). Reads the latest state each render, so it's always current.
  const writePlayerState = (progress: number) => {
    try {
      localStorage.setItem(
        PLAYER_STATE_KEY,
        JSON.stringify({
          tracks,
          currentTrackIndex,
          volume,
          isMuted,
          favorites,
          personalFm,
          audioProgress: progress,
        }),
      );
    } catch {
      /* storage full / disabled — best effort */
    }
  };
  // Queue / index / settings changes persist immediately.
  useEffect(() => {
    writePlayerState(audioProgress);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks, currentTrackIndex, volume, isMuted, favorites, personalFm]);
  // Playback position ticks ~4×/s; throttle its writes to at most once every 2s.
  const lastPosPersistRef = useRef(0);
  useEffect(() => {
    const now = Date.now();
    if (now - lastPosPersistRef.current < 2000) return;
    lastPosPersistRef.current = now;
    writePlayerState(audioProgress);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioProgress]);

  // Chat Submission to Claudio API
  const handleSendMessage = async (e?: FormEvent) => {
    if (e) e.preventDefault();
    if (!inputText.trim()) return;

    const userMsgText = inputText.trim();
    setInputText('');

    // Unlock browser autoplay *within this click gesture*. The agent round-trip can take tens of
    // seconds, by which point the gesture is stale and audio.play() would be blocked — so the
    // auto-started queue never sounds. A muted play→pause here grants the page permission to start
    // playback programmatically once the queue arrives.
    try {
      const a = audioRef.current;
      if (a && a.paused) {
        a.muted = true;
        await a.play();
        a.pause();
        a.currentTime = 0;
        a.muted = false;
      }
    } catch {
      // If priming fails the worst case is the queue shows paused and the user taps play.
      if (audioRef.current) audioRef.current.muted = false;
    }

    // Append User Message to local feed
    const userMsgId = Math.random().toString();
    const newUserMessage: Message = {
      id: userMsgId,
      sender: 'user',
      text: userMsgText,
      timestamp: formatLocalTime(new Date()),
    };

    forceScrollRef.current = true; // always reveal the new turn (and its incoming AI reply)
    setMessages((prev) => [...prev, newUserMessage]);
    setIsTyping(true);

    // Live DJ message that fills in as tokens/tools stream in — ordered text/tool blocks (natural
    // flow: speak-then-tool or tool-then-speak, all kept).
    const liveId = Math.random().toString();
    const liveBlocks: MsgBlock[] = [];
    let liveQueue: Track[] = []; // the playlist this turn commits (mode:"set") — persists on the bubble
    const pushText = (t: string) => {
      const last = liveBlocks[liveBlocks.length - 1];
      if (last && last.type === 'text') last.text += t;
      else liveBlocks.push({ type: 'text', text: t });
    };
    const cloneBlocks = (): MsgBlock[] =>
      liveBlocks.map((b) => (b.type === 'text' ? { ...b } : { type: 'tool', tool: { ...b.tool } }));
    const blocksText = () =>
      liveBlocks
        .filter((b) => b.type === 'text')
        .map((b) => (b as any).text)
        .join('');

    try {
      // Call full-stack endpoint. It streams LangGraph's NATIVE events as SSE:
      // on_chat_model_stream (reply delta) / on_tool_start / on_tool_end. No custom protocol —
      // side effects (the playback queue, player ops) ride the producing tool's on_tool_end output.
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userMsgText,
        }),
      });
      if (!response.body) throw new Error('No response stream');

      // Swap the typing dots for an (empty) streaming bubble that we keep updating.
      setIsTyping(false);
      setMessages((prev: Message[]) => [
        ...prev,
        {
          id: liveId,
          sender: 'claudio',
          text: '',
          timestamp: formatLocalTime(new Date()),
          avatarUrl: claudioAvatar,
          blocks: [],
          streaming: true,
        } as Message,
      ]);
      const syncLive = () =>
        setMessages((prev: Message[]) =>
          prev.map((m: Message) =>
            m.id === liveId ? { ...m, text: blocksText(), blocks: cloneBlocks() } : m,
          ),
        );

      // A side effect rides a tool's on_tool_end output (JSON with an `op`): drive the player from it.
      // 串词不再随队列下发：开了「逐曲解说」设置后由 narration useEffect 按当前歌生成口播。chat 文本不自动朗读 (D-13)。
      const applyToolEffect = (output: string) => {
        let p: any;
        try {
          p = JSON.parse(output);
        } catch {
          return;
        }
        if (!p || typeof p !== 'object') return;
        switch (p.op) {
          case 'set': {
            const queue: Track[] = p.queue || [];
            if (queue.length > 0) {
              liveQueue = queue; // remember it so the bubble keeps a "play this playlist" button
              addSystemLog(`Claudio set a ${queue.length}-song queue. On air.`);
              setPersonalFm(false); // 建新歌单 → 关掉私人 FM，别让 FM 续流和新单打架
              setTracks(queue);
              setCurrentTrackIndex(0);
              setAudioProgress(0);
              setIsPlaying(true); // 自动开播 (D-10)
            }
            break;
          }
          case 'add': {
            const added: Track[] = p.queue || [];
            if (added.length > 0) {
              addSystemLog(`Claudio added ${added.length} song(s) — up next.`);
              // 私人 FM 下队列只有当前一首，FM 续流会在下次拉歌时整队替换、把刚加的歌冲掉。
              // 既然用户要把具体的歌排进队列，就退出单曲流模式，让这些歌真的能轮到播。
              setPersonalFm(false);
              setTracks((prev: Track[]) => {
                const existingIds = new Set(prev.map((t: Track) => t.id));
                const fresh = added.filter((t: Track) => !existingIds.has(t.id));
                if (fresh.length === 0) return prev;
                const insertAt = prev.length ? currentTrackIndex + 1 : 0;
                return [...prev.slice(0, insertAt), ...fresh, ...prev.slice(insertAt)];
              });
            }
            break;
          }
          case 'remove': {
            const ids: string[] = p.removedIds || [];
            if (ids.length > 0)
              setTracks((prev: Track[]) => prev.filter((t: Track) => !ids.includes(t.id)));
            break;
          }
          case 'clear':
            setTracks([]);
            setIsPlaying(false);
            break;
          case 'player':
            switch (p.playerOp) {
              case 'pause':
                setIsPlaying(false);
                break;
              case 'resume':
              case 'play':
                setIsPlaying(true);
                break;
              case 'stop':
                handleStop();
                break;
              case 'skip':
                handleNextTrack();
                break;
            }
            break;
          case 'seek':
            if (typeof p.seconds === 'number' && audioRef.current) {
              audioRef.current.currentTime = Math.max(0, p.seconds);
              setAudioProgress(audioRef.current.currentTime);
            }
            break;
          case 'volume':
            if (typeof p.volume === 'number') setVolume(Math.min(1, Math.max(0, p.volume)));
            if (typeof p.muted === 'boolean') setIsMuted(p.muted);
            break;
          case 'play_index':
            if (typeof p.index === 'number') {
              setTracks((prev) => {
                if (prev.length > 0) {
                  // Anchor on the song id the agent actually picked: positions can drift between the
                  // server mirror and this local queue (dedup-on-add, reorder), so a bare index could
                  // land on the wrong track. Find the id; fall back to the position only if it's gone.
                  let target = Math.min(p.index, prev.length - 1);
                  if (typeof p.id === 'string' && p.id) {
                    const byId = prev.findIndex((t) => t.id === p.id);
                    if (byId >= 0) target = byId;
                  }
                  setCurrentTrackIndex(target);
                }
                return prev;
              });
              setAudioProgress(0);
              setIsPlaying(true);
            }
            break;
          case 'fm':
            // 逐曲解说（串词）开关：现在是 TTS 设置项，agent 的 fm_mode 工具实时翻转它。
            if (typeof p.on === 'boolean') {
              setConfigState((prev: any) => ({ ...prev, tts: { ...prev.tts, narration: p.on } }));
            }
            break;
          case 'personal_fm': {
            // 私人 FM 单曲流开关：agent 的 personal_fm({action}) 工具触发。
            if (typeof p.on !== 'boolean') break;
            if (!p.on) {
              setPersonalFm(false);
              break;
            } // 关：停在当前这首，不动播放
            const wasOn = personalFmRef.current;
            setPersonalFm(true);
            // 关→开：是真正的状态跳变，由 toggle effect (见下方 useEffect) 拉第一首 FM 并自动播，这里不重复拉。
            if (!wasOn) break;
            // 本来「就开着」——但这可能是个不一致状态：localStorage 恢复的陈旧 FM 标志 + /api/tracks 灌进来的
            // 大队列、或 stopped/paused。没有状态跳变 → toggle effect 不会触发 → 必须在这儿亲手把流启动起来，
            // 否则用户再说「fm」永远没反应。判断真实播放态（直接读 <audio>，不靠可能过期的 React state）：
            const a = audioRef.current;
            const isFmStream = tracksRef.current.length === 1; // 真·单曲流队列只有一首
            if (a && !a.paused && isFmStream) break; // 已经在放 FM，别打断
            if (a && a.paused && a.currentTime > 0 && isFmStream)
              setIsPlaying(true); // 暂停在 FM 单曲上 → 续播
            else fetchFmRef.current(); // 其余（stopped/大队列/陈旧）→ 拉一首新鲜 FM
            break;
          }
        }
      };

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() || '';
        for (const frame of frames) {
          const line = frame.trim();
          if (!line.startsWith('data:')) continue;
          const ev = JSON.parse(line.slice(5).trim());
          switch (ev.event) {
            case 'on_chat_model_stream': {
              const t = ev.data?.chunk?.content || '';
              if (t) {
                pushText(t);
                syncLive();
              }
              break;
            }
            case 'on_tool_start': {
              liveBlocks.push({
                type: 'tool',
                tool: { id: ev.run_id, name: ev.name, input: ev.data?.input, status: 'running' },
              });
              syncLive();
              break;
            }
            case 'on_tool_end': {
              const out = ev.data?.output ?? '';
              const blk = liveBlocks.find((b) => b.type === 'tool' && b.tool.id === ev.run_id);
              if (blk && blk.type === 'tool') {
                blk.tool.output = out;
                blk.tool.status = 'done';
              }
              syncLive();
              applyToolEffect(out); // side effect rides the tool return
              break;
            }
          }
        }
      }

      // Finalize the streaming bubble (stop the cursor; attach the committed playlist if any).
      // Force a definitive scroll-to-bottom now that every line is in the DOM: a reply that lands as
      // one big chunk (e.g. a config-error notice) can overshoot the near-bottom follow threshold
      // mid-stream and leave its lower lines hidden below the fold — this guarantees the whole message
      // is revealed once the turn closes.
      forceScrollRef.current = true;
      setMessages((prev: Message[]) =>
        prev.map((m: Message) =>
          m.id === liveId
            ? {
                ...m,
                streaming: false,
                blocks: cloneBlocks(),
                text: blocksText(),
                queue: liveQueue.length ? liveQueue : undefined,
              }
            : m,
        ),
      );
      // The finalize swap removes the cursor and grows the bubble (footer timestamp/replay + the
      // sketch-line decorations lay out a frame late). The effect's forceScroll measures height the
      // instant React commits, so re-pin across the next two frames so that late growth can't leave
      // the freshly-finished reply pushed below the fold.
      requestAnimationFrame(() => {
        const feed = chatFeedRef.current;
        if (feed) feed.scrollTop = feed.scrollHeight;
        requestAnimationFrame(() => {
          const f = chatFeedRef.current;
          if (f) f.scrollTop = f.scrollHeight;
        });
      });
    } catch (err: any) {
      console.error(err);
      setIsTyping(false);

      // Fallback response from DJ Claudio directly in client code
      const fallbackReplies = [
        'Take a slow breath, my friend. It is peaceful here on the late-night airwaves.',
        "Your presence on this late night frequency is a gift. Let's let the records play.",
        "Let the warm crackle of the audio soothe your coding fatigue. I'm right here with you.",
        'Indeed. It is late, and every line drops into a whisper on Claudio FM. Just breathe.',
      ];
      const randomReply = fallbackReplies[Math.floor(Math.random() * fallbackReplies.length)];
      const fallbackMsgId = Math.random().toString();
      const fallbackText = `${randomReply} (Claudio secure local receiver online.)`;

      setMessages((prev: Message[]) => [
        // drop the half-streamed bubble if the stream broke mid-way
        ...prev.filter((m: Message) => m.id !== liveId),
        {
          id: fallbackMsgId,
          sender: 'claudio',
          text: fallbackText,
          timestamp: formatLocalTime(new Date()),
          avatarUrl: claudioAvatar,
        },
      ]);
      handleSpeechReplay(fallbackMsgId, fallbackText);
    }
  };

  const handleSaveConfig = async (e: FormEvent) => {
    e.preventDefault();
    try {
      // Save LLM/TTS configs
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(configState),
      });

      // Save TASTE details too
      const tasteRes = await fetch('/api/taste', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taste: tasteState }),
      });

      if (res.ok && tasteRes.ok) {
        const saved = await res.json();
        if (saved.success) {
          setConfigState(saved.config);
          setShowConfigModal(false);
          addSystemLog('Claudio configuration and Music Taste profile updated successfully.');
        }
      } else {
        throw new Error('Failed to save configs');
      }
    } catch (err: any) {
      console.error('Save config failed:', err);
      alert(`Failed to save configuration: ${err.message}`);
    }
  };

  const handleGenerateTaste = async () => {
    setIsGeneratingTaste(true);
    addSystemLog('Claudio is querying NetEase cloud and analyzing your liked songs list...');
    try {
      const res = await fetch('/api/taste/generate', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          setTasteState(data.taste);
          addSystemLog('Dynamic music taste profile generated and saved successfully!');
          setShowTastePrompt(false);

          // Persist to chat_history.jsonl (not just local state) so the 画像 survives a window refresh.
          addClaudioNote(
            `这是我根据你的网易云心动歌单生成的个人音乐品味：\n\n${data.taste}\n\n我已经将它录入到我的音乐系统设定集。让我们点播一首舒缓惬意的曲目吧。`,
          );
        } else {
          throw new Error(data.error || 'Generation error');
        }
      } else {
        const errVal = await res.json();
        throw new Error(errVal.error || 'Response failed');
      }
    } catch (err: any) {
      console.error('Generate taste failed:', err);
      addSystemLog(`Taste profile generation skipped: ${err.message}`);
    } finally {
      setIsGeneratingTaste(false);
    }
  };

  // Speech Recognition (Mic text capture)
  const handleToggleVoiceInput = () => {
    if (isListening) {
      setIsListening(false);
      return;
    }

    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      setSpeechError('Speech recognition is not supported in this browser frame.');
      setTimeout(() => setSpeechError(null), 3000);
      return;
    }

    try {
      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.lang = 'en-US';

      recognition.onstart = () => {
        setIsListening(true);
        setSpeechError(null);
      };

      recognition.onresult = (event: any) => {
        const transcript = event.results[0][0].transcript;
        if (transcript) {
          setInputText(transcript);
        }
        setIsListening(false);
      };

      recognition.onerror = (event: any) => {
        console.error('Speech Recognition Error', event);
        setSpeechError('Microphone connection failed or permission denied.');
        setIsListening(false);
        setTimeout(() => setSpeechError(null), 3000);
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      recognition.start();
    } catch (e: any) {
      console.error(e);
      setSpeechError('Failed to initiate voice capture.');
      setIsListening(false);
      setTimeout(() => setSpeechError(null), 3000);
    }
  };

  // Full track queue
  const visibleTracks = tracks;

  // When the queue panel opens, scroll the currently-playing track into the middle of the list so the
  // user lands on "what's playing now" instead of the top of a long queue. rAF waits for the panel to
  // lay out. Use getBoundingClientRect deltas (robust regardless of the container's positioning) —
  // offsetTop would be wrong here because the scroll container isn't the rows' offsetParent.
  useEffect(() => {
    if (!showQueue) return;
    const id = requestAnimationFrame(() => {
      const container = queueScrollRef.current;
      const row = activeQueueRowRef.current;
      if (!container || !row) return;
      const cRect = container.getBoundingClientRect();
      const rRect = row.getBoundingClientRect();
      const delta = rRect.top - cRect.top - (container.clientHeight / 2 - row.clientHeight / 2);
      container.scrollTop += delta;
    });
    return () => cancelAnimationFrame(id);
  }, [showQueue, currentTrackIndex]);

  // Render Volume Icon
  const getVolumeIcon = () => {
    if (isMuted || volume === 0) return <VolumeX className="h-4 w-4" />;
    if (volume < 0.4) return <Volume className="h-4 w-4" />;
    if (volume < 0.7) return <Volume1 className="h-4 w-4" />;
    return <Volume2 className="h-4 w-4" />;
  };

  // Fall back to an empty track when the queue is empty (e.g. the agent's `clear` tool, or removing
  // the last song, sets tracks to []). Without this, activeTrack is undefined and the audio src /
  // now-playing title below read .url/.title off undefined and white-screen the whole app mid tool-call.
  const activeTrack = tracks[currentTrackIndex] ?? {
    id: '',
    title: '',
    artist: '',
    album: '',
    duration: 0,
    url: '',
    story: '',
  };
  const WeatherIcon = weather ? weatherIcon(weather.code, weather.desc) : null;
  // 可爱猫 in light, 小野猫 in dark.
  const claudioAvatar = colorMode === 'dark' ? CLAUDIO_AVATAR_DARK : CLAUDIO_AVATAR_LIGHT;

  // The Electron desktop shell sets window.desktop.isDesktop (see desktop/preload.cjs).
  // In that mode we strip the page chrome (padding + ambient orbs) and let the
  // #claudio-terminal panel fill the whole window.
  const isDesktop = typeof window !== 'undefined' && !!(window as any).desktop?.isDesktop;

  // Volume control extracted so it can sit either at the end of the button row (dark) or inline
  // on the progress/scrub row (light, per 用户要求把进度条和音量放一行).
  const volumeControl = (
    <div className="flex items-center gap-1.5 select-none">
      <SketchIconButton
        mode={colorMode}
        id="media-volume-mute"
        onClick={toggleMute}
        title="Toggle Mute"
        className={`p-1.5 rounded-full hover:bg-slate-500/5 ${
          colorMode === 'dark'
            ? 'text-slate-400 hover:text-white'
            : 'text-amber-700 hover:text-amber-900'
        }`}
      >
        {getVolumeIcon()}
      </SketchIconButton>
      <SketchSlider
        mode={colorMode}
        min={0}
        max={1}
        step={0.05}
        value={volume}
        onValueChange={(vol) => {
          setVolume(vol);
          setIsMuted(false);
          if (audioRef.current) audioRef.current.volume = vol;
        }}
        style={{ width: '5rem' }}
        className="w-16 md:w-20 h-1 rounded-lg bg-slate-500/25 appearance-none cursor-pointer accent-slate-400"
      />
    </div>
  );

  return (
    <div
      ref={rootRef}
      className={`h-screen overflow-hidden font-sans relative flex flex-col items-center ${isDesktop ? 'p-0' : 'p-3 md:p-6'} ${
        colorMode === 'dark'
          ? 'bg-[#080612] text-slate-100'
          : 'theme-sketch bg-[#fbf6ec] text-slate-900'
      }`}
      style={
        colorMode === 'dark'
          ? {
              backgroundImage: 'radial-gradient(rgba(139, 92, 246, 0.12) 1.2px, transparent 0)',
              backgroundSize: '28px 28px',
            }
          : {
              // Faint ruled-paper lines for a hand-drawn notebook feel.
              backgroundImage:
                'repeating-linear-gradient(0deg, transparent 0, transparent 27px, rgba(193,133,82,0.10) 27px, rgba(193,133,82,0.10) 28px)',
            }
      }
    >
      {/* Desktop title-bar strip: holds the macOS traffic lights and is the window
          drag handle. Mirrors the #terminal-footer bar (height/color/border) for
          symmetry; pushes content down without changing the app's own layout. */}
      {isDesktop && (
        <div
          style={{ WebkitAppRegion: 'drag' } as CSSProperties}
          className={`shrink-0 w-full h-10 border-b ${
            colorMode === 'dark'
              ? 'border-[#211b33] bg-[#0d0a1b]/95'
              : 'border-[#fbe6da] bg-[#fff7f1]'
          }`}
        />
      )}

      {/* Hand-drawn wobble filter — applied via CSS to lucide icons in the light sketch theme so
          their clean vector strokes read as sketched. feTurbulence noise drives a displacement map. */}
      <svg width="0" height="0" className="absolute" aria-hidden>
        {/* Gentle wobble for small lucide icons. */}
        <filter id="rough-sketch" x="-20%" y="-20%" width="140%" height="140%">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.022"
            numOctaves="3"
            seed="7"
            result="noise"
          />
          <feDisplacementMap
            in="SourceGraphic"
            in2="noise"
            scale="1.8"
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
        {/* Stronger, looser wobble for the big display type (clock / wordmark / titles). */}
        <filter id="rough-sketch-strong" x="-20%" y="-20%" width="140%" height="140%">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.014"
            numOctaves="3"
            seed="4"
            result="noise"
          />
          <feDisplacementMap
            in="SourceGraphic"
            in2="noise"
            scale="3.4"
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      </svg>

      {/* Background Ambience Underglow (page chrome — hidden in the desktop shell) */}
      {!isDesktop && (
        <>
          <div
            className={`absolute top-1/4 left-1/4 w-[300px] md:w-[600px] h-[300px] md:h-[600px] rounded-full filter blur-[100px] hover:blur-[140px] transition-all duration-1000 -z-10 pointer-events-none opacity-40 ${
              colorMode === 'dark' ? 'bg-purple-900/40' : 'bg-amber-300/35'
            }`}
          />
          <div
            className={`absolute bottom-1/4 right-1/4 w-[250px] md:w-[500px] h-[250px] md:h-[500px] rounded-full filter blur-[100px] -z-10 pointer-events-none opacity-35 ${
              colorMode === 'dark' ? 'bg-teal-900/30' : 'bg-rose-300/25'
            }`}
          />
        </>
      )}

      {/* Page-corner credits (page chrome — hidden in the desktop shell where the panel
          fills the window). Concept/prototype + code implementation. */}
      {!isDesktop && (
        <div
          id="page-credits"
          className={`absolute bottom-4 right-5 md:bottom-6 md:right-8 z-20 flex flex-col items-end gap-1.5 font-mono text-[10px] tracking-wide leading-none select-none ${
            colorMode === 'dark' ? 'text-slate-500' : 'text-amber-700/70'
          }`}
        >
          <a
            href="https://mmguo.dev/"
            target="_blank"
            rel="noreferrer"
            title="创意与原型 · mmguo.dev"
            className={`group inline-flex items-center gap-1.5 transition-colors ${
              colorMode === 'dark' ? 'hover:text-purple-300' : 'hover:text-amber-900'
            }`}
          >
            <span className="opacity-40 uppercase">Concept</span>
            <span className="opacity-90 group-hover:opacity-100">mmguo.dev</span>
            <ArrowUpRight className="h-3 w-3 opacity-40 group-hover:opacity-90" />
          </a>
          <a
            href="https://github.com/naihuhu/openclaudio"
            target="_blank"
            rel="noreferrer"
            title="代码实现 · github.com/naihuhu/openclaudio"
            className={`group inline-flex items-center gap-1.5 transition-colors ${
              colorMode === 'dark' ? 'hover:text-purple-300' : 'hover:text-amber-900'
            }`}
          >
            <span className="opacity-40 uppercase">Code</span>
            <span className="opacity-90 group-hover:opacity-100">naihuhu/openclaudio</span>
            <ArrowUpRight className="h-3 w-3 opacity-40 group-hover:opacity-90" />
          </a>
        </div>
      )}

      {/* Embedded Audio Element */}
      <audio
        id="broadcaster-audio"
        ref={audioRef}
        src={withCacheBust(activeTrack.url)}
        preload="auto"
      />

      {/* Main Terminal Container Frame */}
      <div
        id="claudio-terminal"
        className={`relative w-full flex-1 min-h-0 flex flex-col transition-colors duration-500 overflow-hidden ${isDesktop ? 'max-w-none rounded-none border-0' : 'max-w-[520px] rounded-2xl border'} ${
          colorMode === 'dark'
            ? 'claudio-ambient-glow bg-[#110e20]/80 border-[#2c2744] backdrop-blur-xl'
            : 'bg-[#fffaf6]/80 border-transparent shadow-[0_12px_60px_rgba(193,120,60,0.14)] backdrop-blur-xl'
        }`}
      >
        {/* Inner bloom: pointer-events-none overlay above the content that paints a soft, diffuse
            inset glow around the whole inner edge — the panel reads as lit from within. Breathes
            in sync with the outer .claudio-ambient-glow. Dark mode only; rounded-[inherit] +
            the card's overflow-hidden keep it flush with the corners. */}
        {colorMode === 'dark' && (
          <div
            aria-hidden
            className="claudio-inner-bloom pointer-events-none absolute inset-0 z-30 rounded-[inherit]"
          />
        )}
        {colorMode === 'light' && (
          <RoughOverlay stroke="#c0763a" strokeWidth={2.2} roughness={1.9} inset={5} seed={7} />
        )}
        {/* TOP STATUS BAR CONTAINER */}
        <header
          id="terminal-header"
          data-sketch-line="bottom"
          className={`shrink-0 flex items-center justify-between px-5 py-4 border-b ${
            colorMode === 'dark' ? 'border-[#211b33]' : 'border-[#fbe6da]'
          }`}
        >
          {/* Logo Brand Title with Pixelated Style */}
          <div className="flex items-center gap-3">
            <button
              id="brand-circle-btn"
              onClick={() => setShowConfigModal(true)}
              title="Open Claudio Settings"
              className="relative group cursor-pointer border-0 bg-transparent focus:outline-hidden rounded-full"
            >
              <div
                className={`absolute -inset-1 rounded-full bg-gradient-to-r from-violet-600 to-teal-400 blur-sm transition duration-300 ${
                  colorMode === 'dark' ? 'opacity-60 group-hover:opacity-100' : 'opacity-0'
                }`}
              />
              <div
                className={`relative w-9 h-9 rounded-full flex items-center justify-center border ${
                  colorMode === 'dark'
                    ? 'bg-[#120f26] border-white/20'
                    : 'bg-[#fff8ee] border-transparent'
                }`}
              >
                <Disc
                  className={`h-5 w-5 ${colorMode === 'dark' ? 'text-purple-400' : 'text-amber-600'} ${
                    isPlaying ? 'animate-spin' : ''
                  }`}
                  style={{ animationDuration: '3.5s' }}
                />
              </div>
            </button>

            <button
              id="brand-label-btn"
              data-no-sketch
              onClick={() => setShowConfigModal(true)}
              title="Open Claudio Settings"
              style={
                colorMode === 'light' ? { fontFamily: CLOCK_FONTS[clockFontIdx].stack } : undefined
              }
              className={`font-digital text-3xl font-bold tracking-widest cursor-pointer border-0 bg-transparent focus:outline-white text-left ${
                colorMode === 'dark'
                  ? 'text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 via-purple-400 to-pink-400 animate-glow-pulse'
                  : 'text-[#a85a1e]'
              }`}
            >
              Claudio
            </button>
          </div>

          {/* Theme switcher & Login pill */}
          <div className="flex items-center gap-2">
            <button
              id="login-btn"
              data-no-sketch
              className={`text-xs px-3 py-1.5 rounded-md font-mono tracking-wider transition-all hover:scale-[1.03] ${
                colorMode === 'dark'
                  ? 'text-slate-400 hover:text-white hover:bg-white/5'
                  : 'text-amber-700 hover:text-amber-900 hover:bg-amber-100/60'
              }`}
              onClick={handleOpenLogin}
            >
              {userSession.isLoggedIn ? userSession.nickname || 'ACCOUNT' : 'LOGIN'}
            </button>

            {/* Retro Toggle Pill Capsule */}
            <div
              className={`p-1 flex items-center rounded-full border text-[10px] font-mono select-none ${
                colorMode === 'dark'
                  ? 'border-[#2d2547] bg-[#16122a]'
                  : 'border-amber-200 bg-amber-100/60'
              }`}
            >
              <SketchButton
                mode={colorMode}
                id="theme-dark-toggle"
                onClick={() => switchTheme('dark')}
                className={`px-3 py-1 rounded-full font-bold flex items-center gap-1 transition-all ${
                  colorMode === 'dark'
                    ? 'bg-slate-800 text-purple-300 shadow-sm'
                    : 'text-amber-700/70 hover:text-amber-900'
                }`}
              >
                <span className="inline-flex items-center gap-1 whitespace-nowrap">
                  <Moon className="h-2.5 w-2.5" />
                  DARK
                </span>
              </SketchButton>
              <SketchButton
                mode={colorMode}
                id="theme-light-toggle"
                onClick={() => switchTheme('light')}
                className={`px-3 py-1 rounded-full font-bold flex items-center gap-1 transition-all ${
                  colorMode === 'light'
                    ? 'bg-white text-amber-700 shadow-sm border border-amber-200/60'
                    : 'text-slate-500 hover:text-slate-200'
                }`}
              >
                <span className="inline-flex items-center gap-1 whitespace-nowrap">
                  <Sun className="h-2.5 w-2.5" />
                  LIGHT
                </span>
              </SketchButton>
            </div>
          </div>
        </header>

        {/* Scrollable middle region. Everything between the fixed header and footer lives here so
            that when vertical space is tight (esp. in the light sketch theme, where the handwriting
            font + the 9/10px→11px label bump make every section taller) the overflow is absorbed
            here — the chat feed shrinks/scrolls — instead of the last flex child (the footer) being
            clipped out of the overflow-hidden terminal. */}
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          {/* CLOCK & BROADCAST SECTION — hidden when chat is maximized */}
          {!chatMaximized && (
            <section
              id="broadcast-panel"
              data-sketch-line="bottom"
              className="shrink-0 pt-2.5 pb-2.5 text-center flex flex-col items-center justify-center relative border-b border-dashed border-slate-500/10"
            >
              {/* LED Digital Display */}
              <div className="relative">
                <span
                  onClick={() => {
                    if (colorMode === 'light') setClockFontIdx((i) => (i + 1) % CLOCK_FONTS.length);
                  }}
                  title={colorMode === 'light' ? 'Click to change font' : undefined}
                  style={
                    colorMode === 'light'
                      ? { fontFamily: CLOCK_FONTS[clockFontIdx].stack }
                      : undefined
                  }
                  className={`font-digital text-8xl leading-none tracking-normal font-bold relative inline-flex items-center gap-2 tabular-nums ${
                    colorMode === 'dark'
                      ? 'text-white drop-shadow-[0_0_12px_rgba(139,92,246,0.6)]'
                      : 'text-[#a85a1e] cursor-pointer'
                  }`}
                >
                  {formatTimeHoursMinutes(currentTime)}
                  {/* Fixed width so the changing seconds (in fonts without tabular figures) don't
                  resize the centered clock and jolt the HH:MM position every tick. */}
                  <span
                    className="text-[32px] font-mono opacity-40 ml-1 select-none font-normal relative -top-3 tabular-nums inline-block w-[1.5em] text-left"
                    style={colorMode === 'light' ? { fontFamily: 'inherit' } : undefined}
                  >
                    {formatTimeSeconds(currentTime)}
                  </span>
                </span>
              </div>

              {/* Date Label (weekday + date combined) */}
              <span className="text-[10px] font-mono tracking-[0.25em] text-slate-500 block mt-0 mb-0 select-none">
                {formatLocalDate(currentTime)}
              </span>

              {/* Station State Green Dot Indicator */}
              <div className="flex items-center gap-2 mt-2.5">
                <span
                  className={`inline-block w-2.5 h-2.5 rounded-full relative ${
                    isPlaying ? 'bg-emerald-500' : 'bg-amber-500'
                  }`}
                >
                  <span
                    className={`absolute inset-0 rounded-full opacity-75 animate-ping ${
                      isPlaying ? 'bg-emerald-400' : 'bg-amber-400'
                    }`}
                  />
                </span>
                <span
                  className={`text-[10px] font-mono tracking-widest uppercase font-bold ${
                    isPlaying ? 'text-emerald-500' : 'text-amber-500'
                  }`}
                >
                  {isPlaying ? '● ON AIR' : '● STANDBY'}
                </span>
              </div>
            </section>
          )}

          {/* MUSIC CONTROLS & DYNAMIC EQUALIZER CARD */}
          <section
            id="media-controller-box"
            className={`relative overflow-hidden shrink-0 px-5 pt-2.5 pb-2.5 transition-all ${
              colorMode === 'dark' ? 'bg-[#16122d]/60' : 'bg-[#fff1ea]/60'
            }`}
          >
            {/* Audio-reactive light sources — fixed glow blobs that brighten/dim with --glow-pulse
              (live music amplitude). Sits behind the controls (-z-10). Dark only. */}
            {colorMode === 'dark' && (
              <div
                className="media-glow-field pointer-events-none absolute inset-0 -z-10"
                aria-hidden
              />
            )}
            {/* Main Track Detail Header Line */}
            <div
              className={`flex flex-col justify-between gap-3 ${colorMode === 'light' ? 'mb-0' : 'mb-4'}`}
            >
              {/* Visualizer bars bouncing + song name */}
              <div className="flex items-center gap-3">
                {/* Equalizer Wave icon */}
                <div className="flex items-end gap-[3px] h-6 w-7 pb-1 select-none">
                  {[1, 2, 3, 4, 5].map((i) => (
                    <div
                      key={i}
                      className={`w-[3px] rounded-t-sm ${isPlaying ? 'equ-bar' : ''} ${
                        colorMode === 'dark'
                          ? 'bg-gradient-to-t from-emerald-500 to-teal-400'
                          : 'bg-amber-500'
                      }`}
                      style={{
                        // While playing, the staggered negative delay makes each bar bounce out of
                        // phase. When paused, the equ-bar animation is removed entirely and the bars
                        // sit at a fixed short height — always the same uniform "dots" line.
                        animationDelay: `${-i * 0.15}s`,
                        height: isPlaying ? '100%' : '25%',
                      }}
                    />
                  ))}
                </div>

                {/* Title / Artist details */}
                <div className="flex-1 min-w-0">
                  <Marquee className="text-sm font-semibold tracking-wide">
                    <span className={colorMode === 'light' ? 'text-amber-900' : 'text-white'}>
                      {activeTrack.title}
                    </span>
                    <span className="text-xs opacity-50 font-normal"> — {activeTrack.artist}</span>
                  </Marquee>
                  <span
                    className={`text-[9px] font-mono tracking-widest block uppercase ${
                      isPlaying ? 'text-emerald-500 font-bold' : 'text-slate-500'
                    }`}
                  >
                    {isPlaying ? 'PLAYING' : 'PAUSED'}
                  </span>
                </div>
              </div>

              {/* Interactive media control buttons */}
              {/* flex-wrap: in the light "sketch" theme wired-button controls are fatter (fixed 10px
                internal padding), so without wrapping the row overflows and the volume slider spills
                outside the panel. Wrapping drops overflowing controls to the next line instead. */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <SketchIconButton
                  mode={colorMode}
                  id="media-prev"
                  onClick={handlePrevTrack}
                  title="Previous Track"
                  className={`p-2 rounded-full border transition-all active:scale-95 ${
                    colorMode === 'dark'
                      ? 'border-slate-800 hover:bg-white/5 text-slate-300'
                      : 'border-amber-200 hover:bg-amber-100/50 text-amber-800'
                  }`}
                >
                  <SkipBack className="h-3.5 w-3.5" />
                </SketchIconButton>

                <SketchIconButton
                  mode={colorMode}
                  id="media-play-pause"
                  onClick={handlePlayPause}
                  title={isPlaying ? 'Pause' : 'Play'}
                  className={`rounded-full transition-all active:scale-90 relative ${
                    colorMode === 'dark'
                      ? 'w-9 h-9 shrink-0 inline-flex items-center justify-center bg-purple-600 text-white hover:bg-purple-500 shadow-[0_0_15px_rgba(139,92,246,0.35)]'
                      : 'p-2.5 bg-amber-500 text-white hover:bg-amber-400 shadow-[0_0_15px_rgba(245,158,11,0.4)]'
                  }`}
                >
                  {isPlaying ? (
                    <Pause className="h-4 w-4 fill-white" />
                  ) : (
                    <Play className="h-4 w-4 fill-white translate-x-[1px]" />
                  )}
                </SketchIconButton>

                <SketchIconButton
                  mode={colorMode}
                  id="media-next"
                  onClick={handleNextTrack}
                  title="Next Track"
                  className={`p-2 rounded-full border transition-all active:scale-95 ${
                    colorMode === 'dark'
                      ? 'border-slate-800 hover:bg-white/5 text-slate-300'
                      : 'border-amber-200 hover:bg-amber-100/50 text-amber-800'
                  }`}
                >
                  <SkipForward className="h-3.5 w-3.5" />
                </SketchIconButton>

                <SketchIconButton
                  mode={colorMode}
                  id="media-stop"
                  onClick={handleStop}
                  title="Stop Track"
                  className={`p-2 rounded-full border transition-all active:scale-95 ${
                    colorMode === 'dark'
                      ? 'border-slate-800 hover:bg-white/5 text-slate-400'
                      : 'border-amber-200 hover:bg-amber-100/50 text-amber-700'
                  }`}
                >
                  <Square className="h-3.5 w-3.5 fill-current" />
                </SketchIconButton>

                <div data-rough-wobble className="w-[1px] h-6 bg-slate-500/10 mx-1 select-none" />

                <SketchIconButton
                  mode={colorMode}
                  id="media-fav-toggle"
                  onClick={toggleNeteaseLike}
                  disabled={likeBusy}
                  title={activeTrackLiked ? 'DisLike' : 'Like'}
                  sketchColor={activeTrackLiked ? '#ec4899' : SKETCH_INK}
                  className={`p-2 rounded-full border transition-all ${likeBusy ? 'opacity-60' : ''} ${
                    activeTrackLiked
                      ? 'text-pink-500 border-pink-500/30 bg-pink-500/5 hover:bg-pink-500/10'
                      : colorMode === 'dark'
                        ? 'border-slate-800 hover:bg-white/5 text-slate-400'
                        : 'border-amber-200 hover:bg-amber-100/50 text-amber-700'
                  }`}
                >
                  <Heart className={`h-3.5 w-3.5 ${activeTrackLiked ? 'fill-current' : ''}`} />
                </SketchIconButton>

                <SketchButton
                  mode={colorMode}
                  id="queue-toggle-btn"
                  onClick={() => setShowQueue((v) => !v)}
                  title={showQueue ? 'Hide Queue' : 'View Queue'}
                  sketchColor={showQueue ? '#10b981' : SKETCH_INK}
                  className={`px-2.5 py-1.5 rounded-full border text-[9px] font-mono font-bold tracking-wider transition-all ${
                    showQueue
                      ? 'text-emerald-400 border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/15'
                      : colorMode === 'dark'
                        ? 'border-slate-800 hover:bg-white/5 text-slate-400'
                        : 'border-amber-200 hover:bg-amber-100/50 text-amber-700'
                  }`}
                >
                  QUEUE
                </SketchButton>

                <SketchButton
                  mode={colorMode}
                  id="fm-toggle-btn"
                  onClick={() => setPersonalFm((v) => !v)}
                  title={
                    personalFm
                      ? 'Stop Personal FM (endless single-track stream)'
                      : 'Start Personal FM (auto-plays one song after another forever)'
                  }
                  sketchColor={personalFm ? '#a855f7' : SKETCH_INK}
                  className={`px-2.5 py-1.5 rounded-full border text-[9px] font-mono font-bold tracking-wider transition-all ${
                    personalFm
                      ? 'text-purple-400 border-purple-500/40 bg-purple-500/10 hover:bg-purple-500/15'
                      : colorMode === 'dark'
                        ? 'border-slate-800 hover:bg-white/5 text-slate-400'
                        : 'border-amber-200 hover:bg-amber-100/50 text-amber-700'
                  }`}
                >
                  FM
                </SketchButton>

                {/* Volume control — in dark it lives here at the end of the button row; in light it
                  moves down onto the progress/scrub row so 进度条和音量同在一行。 */}
                {colorMode === 'dark' && (
                  <>
                    <div
                      data-rough-wobble
                      className="w-[1px] h-6 bg-slate-500/10 mx-1 select-none"
                    />
                    {volumeControl}
                  </>
                )}
              </div>
            </div>

            {/* Scrub Area Timeline Timeline Slider */}
            <div className="flex items-center gap-3 select-none mb-0">
              <span className="text-[10px] font-mono tracking-wider w-8 shrink-0 text-right opacity-70">
                {formatDuration(audioProgress)}
              </span>

              <SketchSlider
                mode={colorMode}
                min={0}
                max={audioDuration || 158}
                value={audioProgress}
                onValueChange={(time) => {
                  setAudioProgress(time);
                  if (audioRef.current) audioRef.current.currentTime = time;
                }}
                sketchColor={colorMode === 'light' ? '#d97706' : SKETCH_INK}
                style={{ flex: '1 1 0%', minWidth: 0 }}
                className={`flex-1 min-w-0 h-1.5 rounded-lg appearance-none cursor-pointer transition-all ${
                  colorMode === 'dark'
                    ? 'bg-slate-800 accent-purple-500 hover:accent-purple-400'
                    : 'bg-amber-200/70 accent-amber-500 hover:accent-amber-400'
                }`}
              />

              <span className="text-[10px] font-mono tracking-wider w-8 shrink-0 text-left opacity-70">
                {formatDuration(audioDuration)}
              </span>

              {/* Light theme: volume rides the same row as the progress bar. */}
              {colorMode === 'light' && volumeControl}
            </div>
          </section>

          {/* INLINE QUEUE LIST — toggled by the LIST/HIDE button */}
          {showQueue && (
            <section
              id="queue-list"
              data-sketch-line="bottom"
              className="shrink-0 overflow-hidden border-b border-slate-500/10"
            >
              <div
                className={`flex items-center justify-between px-5 py-2 text-[10px] font-mono tracking-widest uppercase select-none ${
                  colorMode === 'dark'
                    ? 'bg-[#0d0b18] text-slate-500'
                    : 'bg-[#fff3ec] text-amber-700'
                }`}
              >
                <span>QUEUE</span>
                <span>{visibleTracks.length} Tracks</span>
              </div>
              <div ref={queueScrollRef} className="max-h-[180px] overflow-y-auto">
                {visibleTracks.map((trk, i) => {
                  const isActive = tracks[currentTrackIndex]?.id === trk.id;
                  const indexInAllTracks = tracks.findIndex((t) => t.id === trk.id);
                  return (
                    <div
                      key={trk.id}
                      ref={isActive ? activeQueueRowRef : undefined}
                      onClick={() => {
                        setCurrentTrackIndex(indexInAllTracks);
                        setAudioProgress(0);
                        setIsPlaying(true);
                      }}
                      className={`flex items-center justify-between gap-3 px-5 py-2 cursor-pointer text-xs border-l-2 transition-colors ${
                        isActive
                          ? 'border-emerald-500 bg-emerald-500/10 ' +
                            (colorMode === 'dark' ? 'text-emerald-300' : 'text-emerald-700')
                          : 'border-transparent ' +
                            (colorMode === 'dark'
                              ? 'hover:bg-white/5 text-slate-400'
                              : 'hover:bg-amber-100/50 text-amber-800')
                      }`}
                    >
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        {isActive && isPlaying ? (
                          <span className="flex items-end gap-[2px] h-3 w-3 shrink-0">
                            {[0, 1, 2].map((b) => (
                              <motion.span
                                key={b}
                                data-rough-wobble
                                className="w-[2px] h-full bg-current rounded-full origin-bottom"
                                animate={{ scaleY: [0.3, 1, 0.5] }}
                                transition={{
                                  duration: 0.6,
                                  repeat: Infinity,
                                  repeatType: 'reverse',
                                  delay: b * 0.15,
                                  ease: 'easeInOut',
                                }}
                              />
                            ))}
                          </span>
                        ) : isActive ? (
                          <Play className="h-3 w-3 fill-current shrink-0" />
                        ) : (
                          <span className="font-mono text-[10px] opacity-50 w-3 shrink-0 text-center">
                            {i + 1}
                          </span>
                        )}
                        {isActive ? (
                          <Marquee className="min-w-0 flex-1 font-mono">
                            <span>{trk.title}</span>
                          </Marquee>
                        ) : (
                          <span className="font-mono truncate">{trk.title}</span>
                        )}
                      </div>
                      <span className="font-mono text-[10px] opacity-50 truncate max-w-[42%] text-right shrink-0">
                        {trk.artist}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Channel Header Info — click to enlarge/shrink the chat */}
          <div
            onClick={() => setChatMaximized((v) => !v)}
            data-sketch-line="top,bottom"
            className={`shrink-0 px-5 pt-2.5 pb-2.5 flex items-center justify-between select-none cursor-pointer border-t border-b border-slate-500/5 ${
              colorMode === 'dark' ? 'bg-[#110e20]' : 'bg-[#fffaf6]'
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              <span
                className={`text-xs font-semibold tracking-wider ${colorMode === 'light' ? 'font-mono text-[#a85a1e]' : ''}`}
              >
                ● Claudio's Live-Bridge
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-mono tracking-widest uppercase opacity-50">
                Live Interactive Chat
              </span>
              {chatMaximized ? (
                <Minimize2 className="w-3.5 h-3.5 opacity-50" />
              ) : (
                <Maximize2 className="w-3.5 h-3.5 opacity-50" />
              )}
            </div>
          </div>

          {/* CHAT DJ TERMINAL FEED */}
          <>
            <section
              ref={chatFeedRef}
              id="chat-terminal-feed"
              className="flex-1 min-h-0 px-5 py-2.5 flex flex-col gap-3 overflow-y-auto"
            >
              <div className="text-center select-none py-1 mb-2">
                <span
                  className={`inline-block px-3 py-1 rounded-full text-[10px] font-mono ${
                    colorMode === 'dark'
                      ? 'bg-slate-900/40 text-slate-400'
                      : 'bg-amber-100/60 text-amber-700'
                  }`}
                >
                  Connected to Claudio broadcast server. Just ask for beats.
                </span>
              </div>

              {/* Messages loop */}
              <div className="space-y-4">
                {(messages.length > visibleCount || hasMoreHistory) && (
                  <div className="text-center py-1 select-none">
                    <SketchButton
                      mode={colorMode}
                      type="button"
                      id="load-older-btn"
                      disabled={loadingEarlier}
                      onClick={() => {
                        // First reveal more of what's already loaded; once exhausted, pull the next
                        // older page from the server (history is tail-loaded, see loadEarlierMessages).
                        if (messages.length > visibleCount) setVisibleCount((v) => v + 10);
                        else if (hasMoreHistory) loadEarlierMessages();
                      }}
                      className={`px-3 py-1.5 rounded-md text-[10px] font-mono tracking-wider transition-all hover:scale-[1.03] inline-flex items-center gap-1.5 ${
                        colorMode === 'dark'
                          ? 'bg-purple-950/20 text-purple-400 border border-purple-500/10 hover:bg-purple-950/40'
                          : 'bg-amber-100/60 text-amber-700 border border-amber-200 hover:bg-amber-100'
                      }`}
                    >
                      <ChevronUp className="w-3 h-3" />
                      {loadingEarlier
                        ? 'LOADING…'
                        : messages.length > visibleCount
                          ? `LOAD PREVIOUS BROADCASTS (${messages.length - visibleCount} REMAINING)`
                          : 'LOAD EARLIER BROADCASTS'}
                    </SketchButton>
                  </div>
                )}
                {messages.slice(-visibleCount).map((msg) => {
                  if (msg.sender === 'system') {
                    return (
                      <div
                        key={msg.id}
                        className="text-center select-none opacity-50 font-mono text-[9px] tracking-wide my-1"
                      >
                        [SYSTEM] {msg.text} — {msg.timestamp}
                      </div>
                    );
                  }

                  const isClaudio = msg.sender === 'claudio';

                  return (
                    <ChatErrorBoundary key={msg.id}>
                      <motion.div
                        // New bubbles rise into place from just below instead of popping in — a gentle
                        // "顶上去" push as the feed scrolls to the bottom. (y/scale are transforms, so they
                        // don't disturb the scrollHeight the auto-scroll math relies on.) A touch of scale
                        // and a deliberately *under-damped* spring give it a little settle-overshoot — the
                        // old stiffness 420 / damping 34 sat right at critical damping, so it slid in flat
                        // and lifeless; easing under critical lets it land with a small lively bounce.
                        initial={{ opacity: 0, y: 20, scale: 0.96 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        transition={{ type: 'spring', stiffness: 300, damping: 20, mass: 0.8 }}
                        className={`flex ${isClaudio ? 'justify-start' : 'justify-end'} items-start gap-3`}
                      >
                        {/* Avatar on the Left for Claudio */}
                        {isClaudio && (
                          <div className="w-8 h-8 rounded-full border border-slate-500/15 overflow-hidden flex-shrink-0 select-none">
                            <PlaceholderAvatar mode={colorMode} role="dj" />
                          </div>
                        )}

                        {/* Avatar on the Right for User */}
                        {!isClaudio && (
                          <div className="w-8 h-8 rounded-full border border-slate-500/15 overflow-hidden flex-shrink-0 select-none order-last">
                            {userSession.isLoggedIn && userSession.avatarUrl ? (
                              <img
                                src={userSession.avatarUrl}
                                alt="Listen User"
                                className="w-full h-full object-cover"
                                referrerPolicy="no-referrer"
                              />
                            ) : (
                              <PlaceholderAvatar mode={colorMode} role="user" />
                            )}
                          </div>
                        )}

                        <div
                          className={`max-w-[85%] flex flex-col ${isClaudio ? 'items-start' : 'items-end'}`}
                        >
                          <span className="text-[10px] font-mono tracking-wider opacity-60 mb-1 select-none uppercase font-bold">
                            {isClaudio
                              ? 'CLAUDIO'
                              : userSession.isLoggedIn && userSession.nickname
                                ? userSession.nickname
                                : 'LISTEN_USER'}
                          </span>

                          {/* Message Bubble Container */}
                          <div
                            className={`relative p-3.5 rounded-xl border text-xs leading-relaxed transition-all ${
                              isClaudio
                                ? colorMode === 'dark'
                                  ? 'bg-[#18152e] border-[#312c4b] text-slate-100 shadow-sm'
                                  : 'bg-[#fff8ee] border-transparent text-slate-800 shadow-sm'
                                : colorMode === 'dark'
                                  ? 'bg-[#0b2824] border-[#104e43] text-teal-200'
                                  : 'bg-[#fff1f2] border-transparent text-rose-900'
                            }`}
                          >
                            {colorMode === 'light' && (
                              <RoughOverlay
                                stroke={isClaudio ? '#d99a3f' : '#e0809a'}
                                strokeWidth={1.6}
                                roughness={1.7}
                                inset={2}
                                seed={isClaudio ? 11 : 23}
                              />
                            )}
                            {/* Natural flow: ordered text(markdown) + tool blocks; falls back to plain
                          markdown text for history messages without blocks. */}
                            <div className="font-medium leading-relaxed">
                              {msg.blocks && msg.blocks.length > 0 ? (
                                msg.blocks.map((b, bi) => {
                                  // Each block fades/rises in once, the moment it first appears in the
                                  // stream. framer's initial→animate only fires on mount, so a text
                                  // block's later token updates (same key) don't re-trigger it — the
                                  // segment lands softly, then streams in place without re-flashing.
                                  const key = b.type === 'tool' ? b.tool.id : `text-${bi}`;
                                  return (
                                    <motion.div
                                      key={key}
                                      initial={{ opacity: 0, y: 5 }}
                                      animate={{ opacity: 1, y: 0 }}
                                      transition={{ duration: 0.28, ease: 'easeOut' }}
                                    >
                                      {b.type === 'tool' ? (
                                        <ToolCallRow tool={b.tool} colorMode={colorMode} />
                                      ) : (
                                        <Markdown>{b.text}</Markdown>
                                      )}
                                    </motion.div>
                                  );
                                })
                              ) : (
                                <Markdown>{msg.text}</Markdown>
                              )}
                              {msg.streaming && (
                                <span className="inline-block w-1.5 h-3 ml-0.5 align-middle bg-current animate-caret-blink" />
                              )}
                            </div>

                            {/* Claudio Replay option */}
                            {isClaudio && !msg.streaming && (
                              <div
                                data-sketch-line="top"
                                className="mt-3 flex items-center justify-between border-t border-slate-500/10 pt-2 text-[10px]"
                              >
                                <span className="font-mono text-[10px] opacity-40 select-none">
                                  {msg.timestamp}
                                </span>

                                <div className="flex items-center gap-2">
                                  {/* Play-this-playlist — only when this turn committed a playlist (persists across reloads) */}
                                  {msg.queue && msg.queue.length > 0 && (
                                    <SketchButton
                                      mode={colorMode}
                                      sketchColor={SKETCH_INK}
                                      onClick={() => handlePlayQueue(msg.queue!)}
                                      className={`px-3 py-1 rounded-full font-mono font-bold flex items-center gap-1.5 transition-all ${
                                        colorMode === 'dark'
                                          ? 'bg-purple-900/20 border border-purple-500/20 text-purple-400 hover:bg-purple-800/10'
                                          : 'bg-amber-500/10 border border-amber-500/25 text-amber-700 hover:bg-amber-500/15'
                                      }`}
                                    >
                                      ▶ PLAY PLAYLIST · {msg.queue.length}
                                    </SketchButton>
                                  )}
                                </div>
                              </div>
                            )}

                            {/* User messages carry their send time too, shown the same way as Claudio's:
                          an in-bubble footer with a top divider. */}
                            {!isClaudio && msg.timestamp && (
                              <div
                                data-sketch-line="top"
                                className="mt-3 flex items-center justify-between border-t border-slate-500/10 pt-2 text-[10px]"
                              >
                                <span className="font-mono text-[10px] opacity-40 select-none">
                                  {msg.timestamp}
                                </span>
                              </div>
                            )}
                          </div>
                        </div>
                      </motion.div>
                    </ChatErrorBoundary>
                  );
                })}

                {/* Claudio DJ typing simulation */}
                {isTyping && (
                  <div className="flex justify-start items-start gap-3">
                    <div className="w-8 h-8 rounded-full border border-slate-500/15 overflow-hidden flex-shrink-0">
                      <PlaceholderAvatar mode={colorMode} role="dj" />
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[10px] font-mono tracking-wider opacity-60 mb-1 select-none">
                        CLAUDIO
                      </span>
                      <div
                        className={`p-4 rounded-xl border flex items-center gap-1 ${
                          colorMode === 'dark'
                            ? 'bg-[#18152e] border-[#312c4b]'
                            : 'bg-[#fff8ee] border-[#fbe6c4]'
                        }`}
                      >
                        <span
                          className="inline-block w-1.5 h-1.5 rounded-full bg-purple-400 animate-bounce"
                          style={{ animationDelay: '0s' }}
                        />
                        <span
                          className="inline-block w-1.5 h-1.5 rounded-full bg-purple-400 animate-bounce"
                          style={{ animationDelay: '0.15s' }}
                        />
                        <span
                          className="inline-block w-1.5 h-1.5 rounded-full bg-purple-400 animate-bounce"
                          style={{ animationDelay: '0.3s' }}
                        />
                      </div>
                    </div>
                  </div>
                )}

                <div ref={messageEndRef} />
              </div>
            </section>

            {/* INPUT FORM CONTROLS */}
            <section
              id="chat-input-controls"
              className={`shrink-0 px-4 py-2.5 border-t ${
                colorMode === 'dark'
                  ? 'border-[#211b33] bg-[#120f26]'
                  : 'border-transparent bg-[#fff5ef]/60'
              }`}
            >
              {speechError && (
                <div className="text-center select-none py-1 text-xs font-mono text-red-500">
                  {speechError}
                </div>
              )}

              {showTastePrompt && (
                <div
                  className={`relative mb-3 p-3 rounded-xl border flex flex-col sm:flex-row items-center justify-between gap-3 ${
                    colorMode === 'dark'
                      ? 'bg-[#18152e] border-[#312c4b] text-slate-100 shadow-md'
                      : 'bg-[#fff8ee] border-transparent text-slate-800 shadow-sm'
                  }`}
                >
                  {colorMode === 'light' && <RoughOverlay stroke="#d99a3f" inset={2} seed={31} />}
                  <div className="flex items-center gap-2.5">
                    <Music className="h-5 w-5 text-amber-400 animate-pulse flex-shrink-0" />
                    <div className="text-left">
                      <h4 className="text-xs font-bold leading-normal">
                        Generate Music Taste Profile
                      </h4>
                      <p className="text-[10px] opacity-75 mt-0.5">
                        Let Claudio analyze list elements from your netease heart-liked songs to
                        synthesize your late-night mood persona!
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0 w-full sm:w-auto justify-end">
                    <SketchButton
                      mode={colorMode}
                      type="button"
                      onClick={() => {
                        setShowTastePrompt(false);
                        fetch('/api/taste/skip', { method: 'POST' }).catch(() => {
                          /* best-effort */
                        });
                      }}
                      className="px-2.5 py-1.5 rounded-lg text-[10px] font-mono hover:opacity-80 transition-all font-bold select-none"
                    >
                      DISMISS
                    </SketchButton>
                    <SketchButton
                      mode={colorMode}
                      type="button"
                      disabled={isGeneratingTaste}
                      onClick={handleGenerateTaste}
                      className="px-3 py-1.5 rounded-lg text-[10px] font-mono font-bold bg-amber-400 text-slate-950 hover:bg-amber-300 disabled:opacity-50 flex items-center gap-1 shadow-sm transition-transform hover:scale-[1.02] select-none"
                    >
                      {isGeneratingTaste ? 'ANALYZING...' : 'GENERATE NOW'}
                    </SketchButton>
                  </div>
                </div>
              )}

              <form onSubmit={handleSendMessage} className="flex items-center gap-2">
                {/* Main styled relative container */}
                <div className="relative flex-grow flex items-center">
                  <SketchInput
                    mode={colorMode}
                    id="chat-text-input"
                    type="text"
                    value={inputText}
                    onValueChange={setInputText}
                    onEnter={() => handleSendMessage()}
                    placeholder="Say something to the DJ..."
                    disabled={isTyping}
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    className={`w-full py-2.5 pl-4 pr-12 rounded-xl text-xs border tracking-wide transition-all outline-none focus:ring-1 ${
                      colorMode === 'dark'
                        ? 'bg-[#17142b] border-[#2d254c] text-white focus:border-purple-500 focus:ring-purple-500/20 placeholder-slate-500 disabled:opacity-50'
                        : 'bg-white/70 border-transparent focus:border-transparent text-slate-800 focus:ring-amber-500/15 placeholder-amber-400/70 disabled:opacity-50'
                    }`}
                  />

                  {/* Speech Microphone button embedded right side inside form */}
                  <SketchIconButton
                    mode={colorMode}
                    id="chat-mic-btn"
                    type="button"
                    onClick={handleToggleVoiceInput}
                    title={isListening ? 'Stop Voice Input' : 'Microphone Capture'}
                    disabled={isTyping}
                    sketchColor={isListening ? '#ef4444' : SKETCH_INK}
                    className={`absolute right-3 p-1.5 rounded-lg transition-all z-10 ${
                      isListening
                        ? 'text-red-500 bg-red-500/10 border border-red-500/20'
                        : colorMode === 'dark'
                          ? 'text-slate-400 hover:text-white'
                          : 'text-amber-700 hover:text-amber-900'
                    }`}
                  >
                    {isListening ? (
                      <MicOff className="h-4 w-4 animate-pulse" />
                    ) : (
                      <Mic className="h-4 w-4" />
                    )}
                  </SketchIconButton>
                </div>

                {/* Submit arrow button — type=button + explicit handler so it works for wired-button too */}
                <SketchButton
                  mode={colorMode}
                  id="chat-send-btn"
                  type="button"
                  onClick={() => handleSendMessage()}
                  disabled={!inputText.trim() || isTyping}
                  className={`p-2.5 rounded-xl transition-all font-bold ${
                    inputText.trim() && !isTyping
                      ? colorMode === 'dark'
                        ? 'bg-purple-600 hover:bg-purple-500 text-white shadow-sm'
                        : 'bg-amber-500 hover:bg-amber-400 text-white shadow-sm'
                      : colorMode === 'dark'
                        ? 'bg-slate-800 text-slate-600 cursor-not-allowed'
                        : 'bg-amber-100/60 text-amber-400/60 cursor-not-allowed'
                  }`}
                >
                  <Send className="h-3.5 w-3.5" />
                </SketchButton>
              </form>
            </section>
          </>
        </div>
        {/* end scrollable middle region */}

        {/* BOTTOM REAL BROADCASTER FOOTER BAR */}
        <footer
          id="terminal-footer"
          className={`shrink-0 px-5 py-3 border-t text-[10px] font-mono tracking-widest flex items-center justify-between select-none ${
            colorMode === 'dark'
              ? 'border-[#211b33] bg-[#0d0a1b]/95 text-slate-500'
              : 'border-transparent bg-[#fff7f1] text-amber-700/70'
          }`}
        >
          {/* Left: IP-located city only (original Globe icon). */}
          <div className="flex items-center gap-2">
            <Globe className="h-3.5 w-3.5" />
            <span className="font-bold uppercase">{weather?.city || '—'}</span>
          </div>
          {/* Right: IP-located current weather — status icon + temp + feels-like (English). */}
          <div className="flex items-center gap-2">
            {weather && WeatherIcon ? (
              <>
                <WeatherIcon className="h-3.5 w-3.5" />
                <span>
                  {Math.round(weather.temp)}° · FEELS {Math.round(weather.feelsLike)}°
                </span>
              </>
            ) : (
              <>
                <Radio className="h-3.5 w-3.5 animate-pulse" />
                <span>CLAUDIO FM</span>
              </>
            )}
          </div>
        </footer>
      </div>

      {/* QR Code Login Centered Modal Overlay */}
      <AnimatePresence>
        {showQrModal && (
          <motion.div
            id="qr-modal-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none"
          >
            <motion.div
              id="qr-modal-content"
              initial={{ opacity: 0, scale: 0.96, y: 24, filter: 'blur(8px)' }}
              animate={{ opacity: 1, scale: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, scale: 0.96, y: 24, filter: 'blur(8px)' }}
              transition={{ type: 'spring', stiffness: 320, damping: 30, mass: 0.8 }}
              className={`pointer-events-auto relative w-full max-w-[520px] max-h-[calc(100vh-2rem)] overflow-y-auto p-6 rounded-2xl border text-center ${
                colorMode === 'dark'
                  ? 'bg-[#141125] border-[#2f284d] text-slate-100 shadow-[0_30px_80px_-12px_rgba(0,0,0,0.9),0_0_0_1px_rgba(124,58,237,0.15)]'
                  : 'bg-[#fffaf6] border-transparent text-slate-900 shadow-[0_30px_80px_-12px_rgba(120,72,30,0.35),0_0_0_1px_rgba(193,120,60,0.12)]'
              }`}
            >
              {colorMode === 'light' && (
                <RoughOverlay
                  stroke="#c0763a"
                  strokeWidth={2.2}
                  roughness={1.9}
                  inset={5}
                  seed={17}
                />
              )}
              <h2 className="text-sm font-bold tracking-wider mb-2 font-mono flex items-center justify-center gap-2">
                <Music4 className="h-5 w-5 text-purple-400 animate-pulse" />
                {userSession.isLoggedIn ? 'NETEASE MUSIC ACCOUNT' : 'NETEASE MUSIC LOGIN'}
              </h2>

              <p className="text-[10px] text-slate-400 mb-6 leading-relaxed font-mono">
                {userSession.isLoggedIn
                  ? "You're signed in to Netease Cloud Music."
                  : 'Scan with Netease Cloud Music App to import details and red heart playlist.'}
              </p>

              {userSession.isLoggedIn ? (
                /* Logged-in account panel: avatar + nickname + LOGOUT */
                <div className="mb-4">
                  {userSession.avatarUrl ? (
                    <img
                      src={userSession.avatarUrl}
                      alt="avatar"
                      className="mx-auto w-20 h-20 rounded-full object-cover border-2 border-purple-500/40 mb-4"
                    />
                  ) : (
                    <div className="mx-auto w-20 h-20 rounded-full bg-purple-500/15 border-2 border-purple-500/40 flex items-center justify-center mb-4">
                      <Music4 className="h-8 w-8 text-purple-400" />
                    </div>
                  )}
                  <p className="text-sm font-bold font-mono mb-6">
                    {userSession.nickname || 'Netease user'}
                  </p>
                  <SketchButton
                    mode={colorMode}
                    id="logout-btn"
                    type="button"
                    sketchColor="#a855f7"
                    onClick={async () => {
                      await handleLogout();
                      setShowQrModal(false);
                    }}
                    className="w-full py-2.5 rounded-xl font-mono text-xs font-bold transition-all hover:scale-[1.02] active:scale-[0.98] border text-purple-400 border-purple-500/40 bg-purple-500/10 hover:bg-purple-500/15"
                  >
                    LOGOUT
                  </SketchButton>
                </div>
              ) : (
                <>
                  {/* QR Image Framing Container */}
                  <div className="mx-auto w-48 h-48 rounded-xl bg-white border border-slate-705/20 p-3 mb-6 relative flex items-center justify-center overflow-hidden">
                    {qrImg ? (
                      <img
                        src={qrImg}
                        alt="Netease Login QR Code"
                        className="w-full h-full object-contain"
                      />
                    ) : (
                      <div className="flex flex-col items-center justify-center text-slate-400 gap-2">
                        <Disc className="w-8 h-8 animate-spin text-purple-500" />
                        <span className="text-[10px] uppercase tracking-widest font-mono">
                          Loading QR...
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Status banner */}
                  <div
                    className={`p-3 rounded-lg mb-6 text-xs font-mono border leading-relaxed ${
                      colorMode === 'dark'
                        ? 'bg-[#1a172e] border-[#2c264c] text-purple-300'
                        : 'bg-amber-50 border-amber-100 text-amber-700'
                    }`}
                  >
                    {qrStatusText}
                  </div>

                  {/* Cookie login (official web login → paste cookie) */}
                  <div className="mb-4">
                    <div className="flex items-center gap-2 mb-3 select-none">
                      <span
                        className={`flex-1 h-px ${colorMode === 'dark' ? 'bg-[#2c264c]' : 'bg-slate-200'}`}
                      />
                      <span className="text-[9px] font-mono tracking-widest uppercase opacity-50">
                        OR PASTE COOKIE
                      </span>
                      <span
                        className={`flex-1 h-px ${colorMode === 'dark' ? 'bg-[#2c264c]' : 'bg-slate-200'}`}
                      />
                    </div>
                    <p className="text-[10px] text-slate-400 mb-3 leading-relaxed font-mono">
                      Log in at{' '}
                      <a
                        href="https://music.163.com"
                        target="_blank"
                        rel="noreferrer"
                        className={`underline font-bold ${colorMode === 'dark' ? 'text-purple-300 hover:text-purple-200' : 'text-amber-600 hover:text-amber-500'}`}
                      >
                        music.163.com
                      </a>
                      , then paste your cookie below.
                    </p>
                    <SketchTextarea
                      mode={colorMode}
                      id="cookie-input"
                      rows={3}
                      value={cookieInput}
                      onValueChange={setCookieInput}
                      placeholder="MUSIC_U=xxxxxxxx; __csrf=xxxx; ..."
                      className={`w-full px-3 py-2 rounded-lg text-[10px] font-mono border focus:outline-hidden resize-y mb-2 ${
                        colorMode === 'dark'
                          ? 'bg-[#1a172e] border-[#2c264c] text-slate-200 focus:border-purple-500'
                          : 'bg-[#fff5ef] border-amber-200 text-slate-800 focus:border-amber-500'
                      }`}
                    />
                    <SketchButton
                      mode={colorMode}
                      id="cookie-login-btn"
                      type="button"
                      sketchColor="#a855f7"
                      disabled={!cookieInput.trim() || cookieLoggingIn}
                      onClick={handleCookieLogin}
                      className="w-full py-2.5 rounded-xl font-mono text-xs font-bold transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:hover:scale-100 border text-purple-400 border-purple-500/40 bg-purple-500/10 hover:bg-purple-500/15"
                    >
                      {cookieLoggingIn ? 'VALIDATING...' : 'LOGIN WITH COOKIE'}
                    </SketchButton>
                  </div>
                </>
              )}

              {/* Cancel Button */}
              <SketchButton
                mode={colorMode}
                id="qr-cancel-btn"
                onClick={() => {
                  setShowQrModal(false);
                  setIsCheckingQr(false);
                }}
                className={`w-full py-2.5 rounded-xl font-mono text-xs font-bold transition-all hover:scale-[1.02] active:scale-[0.98] ${
                  colorMode === 'dark'
                    ? 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                    : 'bg-amber-100/60 text-amber-800 hover:bg-amber-100'
                }`}
              >
                {userSession.isLoggedIn ? 'CLOSE' : 'CANCEL SYNC'}
              </SketchButton>
            </motion.div>
          </motion.div>
        )}

        {/* Claudio Configurations Settings Modal */}
        {showConfigModal && (
          <motion.div
            id="claudio-config-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 overflow-y-auto pointer-events-none"
          >
            <motion.div
              id="claudio-config-card"
              initial={{ opacity: 0, scale: 0.96, y: 24, filter: 'blur(8px)' }}
              animate={{ opacity: 1, scale: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, scale: 0.96, y: 24, filter: 'blur(8px)' }}
              transition={{ type: 'spring', stiffness: 320, damping: 30, mass: 0.8 }}
              className={`pointer-events-auto relative w-full max-w-[520px] max-h-[calc(100vh-2rem)] overflow-y-auto p-6 rounded-2xl border ${
                colorMode === 'dark'
                  ? 'bg-[#110e20] border-[#312a4b] text-slate-100 shadow-[0_30px_80px_-12px_rgba(0,0,0,0.9),0_0_0_1px_rgba(124,58,237,0.15)]'
                  : 'bg-[#fffaf6] border-transparent text-slate-850 shadow-[0_30px_80px_-12px_rgba(120,72,30,0.35),0_0_0_1px_rgba(193,120,60,0.12)]'
              }`}
            >
              {colorMode === 'light' && (
                <RoughOverlay
                  stroke="#c0763a"
                  strokeWidth={2.2}
                  roughness={1.9}
                  inset={5}
                  seed={29}
                />
              )}
              {/* Header */}
              <div className="flex items-center justify-between mb-5 select-none border-b border-slate-500/10 pb-3">
                <div className="flex items-center gap-2.5">
                  <Sliders className="h-5 w-5 text-purple-400" />
                  <h3 className="font-digital text-2xl font-bold tracking-wider">
                    Claudio Settings
                  </h3>
                </div>
                <SketchIconButton
                  mode={colorMode}
                  type="button"
                  id="close-config-btn"
                  onClick={() => setShowConfigModal(false)}
                  className="p-1.5 rounded-full hover:bg-slate-500/10 transition-colors"
                >
                  <X className="h-4 w-4" />
                </SketchIconButton>
              </div>

              {/* Form */}
              <form onSubmit={handleSaveConfig} className="space-y-4">
                {/* Section API/LLM */}
                <div>
                  <h4 className="text-[10px] font-mono tracking-widest font-bold uppercase text-purple-400 mb-2 flex items-center gap-1.5 border-b border-purple-500/10 pb-1 select-none">
                    <span>1. LLM Provider (OpenAI Compatible)</span>
                  </h4>

                  <div className="space-y-2.5">
                    <div>
                      <label className="block text-[10px] font-mono uppercase mb-1 opacity-60">
                        API Address
                      </label>
                      <SketchInput
                        mode={colorMode}
                        type="url"
                        required
                        placeholder="https://api.openai.com/v1"
                        value={configState.llm.apiAddress}
                        onValueChange={(v) =>
                          setConfigState({
                            ...configState,
                            llm: { ...configState.llm, apiAddress: v },
                          })
                        }
                        className={`w-full px-3 py-1.5 rounded-lg text-xs font-mono border focus:outline-hidden ${
                          colorMode === 'dark'
                            ? 'bg-[#1a172e] border-[#2c264c] text-slate-200 focus:border-purple-500'
                            : 'bg-[#fff5ef] border-amber-200 text-slate-800 focus:border-amber-500'
                        }`}
                      />
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[10px] font-mono uppercase mb-1 opacity-60">
                          API Key
                        </label>
                        <SketchInput
                          mode={colorMode}
                          type="password"
                          placeholder="sk-..."
                          value={configState.llm.apiKey}
                          onValueChange={(v) =>
                            setConfigState({
                              ...configState,
                              llm: { ...configState.llm, apiKey: v },
                            })
                          }
                          className={`w-full px-3 py-1.5 rounded-lg text-xs font-mono border focus:outline-hidden ${
                            colorMode === 'dark'
                              ? 'bg-[#1a172e] border-[#2c264c] text-white focus:border-purple-500'
                              : 'bg-[#fff5ef] border-amber-200 text-slate-800 focus:border-amber-500'
                          }`}
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-mono uppercase mb-1 opacity-60">
                          Model Name
                        </label>
                        <SketchInput
                          mode={colorMode}
                          type="text"
                          required
                          placeholder="gpt-3.5-turbo"
                          value={configState.llm.modelName}
                          onValueChange={(v) =>
                            setConfigState({
                              ...configState,
                              llm: { ...configState.llm, modelName: v },
                            })
                          }
                          className={`w-full px-3 py-1.5 rounded-lg text-xs font-mono border focus:outline-hidden ${
                            colorMode === 'dark'
                              ? 'bg-[#1a172e] border-[#2c264c] text-slate-200 focus:border-purple-500'
                              : 'bg-[#fff5ef] border-amber-200 text-slate-800 focus:border-amber-500'
                          }`}
                        />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Section TTS */}
                <div>
                  <h4 className="text-[10px] font-mono tracking-widest font-bold uppercase text-teal-400 mb-2 flex items-center gap-1.5 border-b border-teal-500/10 pb-1 select-none">
                    <span>2. Doubao Voice TTS (V3 SSE)</span>
                  </h4>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
                    <div>
                      <label className="block text-[10px] font-mono uppercase mb-1 opacity-60">
                        Volcengine API Key
                      </label>
                      <SketchInput
                        mode={colorMode}
                        type="password"
                        placeholder="Api Key"
                        value={configState.tts.apiKey}
                        onValueChange={(v) =>
                          setConfigState({
                            ...configState,
                            tts: { ...configState.tts, apiKey: v },
                          })
                        }
                        className={`w-full px-3 py-1.5 rounded-lg text-xs font-mono border focus:outline-hidden ${
                          colorMode === 'dark'
                            ? 'bg-[#1a172e] border-[#2c264c] text-white focus:border-purple-500'
                            : 'bg-[#fff5ef] border-amber-200 text-slate-800 focus:border-amber-500'
                        }`}
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-mono uppercase mb-1 opacity-60">
                        Resource ID
                      </label>
                      <SketchInput
                        mode={colorMode}
                        type="text"
                        placeholder="e.g. seed-tts-2.0"
                        value={configState.tts.resourceId}
                        onValueChange={(v) =>
                          setConfigState({
                            ...configState,
                            tts: { ...configState.tts, resourceId: v },
                          })
                        }
                        className={`w-full px-3 py-1.5 rounded-lg text-xs font-mono border focus:outline-hidden ${
                          colorMode === 'dark'
                            ? 'bg-[#1a172e] border-[#2c264c] text-slate-200 focus:border-purple-500'
                            : 'bg-[#fff5ef] border-amber-200 text-slate-800 focus:border-amber-500'
                        }`}
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-[10px] font-mono uppercase mb-1 opacity-60">
                      Voice Type / Speaker ID
                    </label>
                    <SketchInput
                      mode={colorMode}
                      type="text"
                      placeholder="e.g. zh_male_wennuanahu_uranus_bigtts"
                      value={configState.tts.voiceType || ''}
                      onValueChange={(v) =>
                        setConfigState({
                          ...configState,
                          tts: { ...configState.tts, voiceType: v },
                        })
                      }
                      className={`w-full px-3 py-1.5 rounded-lg text-xs font-mono border focus:outline-hidden ${
                        colorMode === 'dark'
                          ? 'bg-[#1a172e] border-[#2c264c] text-slate-200 focus:border-purple-500'
                          : 'bg-[#fff5ef] border-amber-200 text-slate-800 focus:border-amber-500'
                      }`}
                    />
                  </div>
                </div>

                {/* Section DJ Patter — per-song narration, broken out as its own setting.
                    When on, every song that starts playing gets a fresh DJ patter spoken over the music via TTS. */}
                <div>
                  <h4 className="text-[10px] font-mono tracking-widest font-bold uppercase text-pink-400 mb-2 flex items-center gap-1.5 border-b border-pink-500/10 pb-1 select-none">
                    <span>3. DJ Patter (Per-Song Narration)</span>
                  </h4>

                  <label className="flex items-center justify-between gap-3 cursor-pointer select-none">
                    <span className="flex flex-col">
                      <span className="text-[10px] font-mono uppercase opacity-80">DJ Patter</span>
                      <span className="text-[9px] font-mono opacity-50">
                        Generate a spoken intro over each song as it starts playing
                      </span>
                    </span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={!!configState.tts.narration}
                      onClick={() =>
                        setConfigState({
                          ...configState,
                          tts: { ...configState.tts, narration: !configState.tts.narration },
                        })
                      }
                      className={`relative w-10 h-5 rounded-full border transition-colors shrink-0 ${
                        configState.tts.narration
                          ? 'bg-purple-500/30 border-purple-500/50'
                          : colorMode === 'dark'
                            ? 'bg-[#1a172e] border-[#2c264c]'
                            : 'bg-[#fff5ef] border-amber-200'
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 left-0.5 w-3.5 h-3.5 rounded-full transition-transform ${
                          configState.tts.narration
                            ? 'translate-x-5 bg-purple-400'
                            : 'translate-x-0 bg-slate-400'
                        }`}
                      />
                    </button>
                  </label>
                </div>

                {/* Action buttons */}
                <div className="flex gap-3 justify-end pt-3 border-t border-slate-500/10">
                  <SketchButton
                    mode={colorMode}
                    type="button"
                    onClick={() => setShowConfigModal(false)}
                    className={`px-4 py-2 rounded-xl text-xs font-mono font-bold transition-all hover:scale-[1.02] ${
                      colorMode === 'dark'
                        ? 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                        : 'bg-amber-100/60 text-amber-800 hover:bg-amber-100'
                    }`}
                  >
                    CANCEL
                  </SketchButton>
                  <SketchButton
                    mode={colorMode}
                    type="button"
                    sketchColor="#a855f7"
                    onClick={(e: any) => handleSaveConfig(e)}
                    className="px-5 py-2 rounded-xl text-xs font-mono font-bold transition-all hover:scale-[1.02] border text-purple-400 border-purple-500/40 bg-purple-500/10 hover:bg-purple-500/15"
                  >
                    SAVE CHANGES
                  </SketchButton>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
