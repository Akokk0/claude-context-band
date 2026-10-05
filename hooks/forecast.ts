import type { Limits, Reading, Turn } from "../types";

/** 留最近几轮,也是柱状图的格数。 */
export const HISTORY = 12;

export type LevelKey = "clear" | "cloudy" | "showers" | "storm" | "tornado";

export type Level = {
  key: LevelKey;
  /** 用到这个百分比以下算这一档。 */
  upTo: number;
  word: string;
  /** 终端里的单宽符号,不用 emoji:每种终端字体里都对得齐。 */
  glyph: string;
  /** 终端里的颜色名。 */
  color: string;
  /** 档位色,浅的那头:头像渐变的起点,暗色下的柱子与数字。晴朗是暖橙,后四档取自 SC 的档位渐变。 */
  a: string;
  /** 档位色,深的那头:头像渐变的终点,亮色下的柱子与数字。 */
  b: string;
};

/** 最后一档:没有上限,哪一档都不是的就是它。 */
const TORNADO: Level = {
  key: "tornado",
  upTo: Number.POSITIVE_INFINITY,
  word: "龙卷风",
  glyph: "≋",
  color: "red",
  a: "#ff7675",
  b: "#d63031",
};

/** 天气分档,按窗口用掉的百分比。阈值与官方 token-weather 一致。 */
export const LEVELS: readonly Level[] = [
  { key: "clear", upTo: 25, word: "晴朗", glyph: "☀", color: "yellow", a: "#fdcb6e", b: "#e17055" },
  { key: "cloudy", upTo: 50, word: "多云", glyph: "☁", color: "cyan", a: "#74b9ff", b: "#0984e3" },
  { key: "showers", upTo: 75, word: "阵雨", glyph: "☂", color: "blue", a: "#a29bfe", b: "#6c5ce7" },
  {
    key: "storm",
    upTo: 90,
    word: "雷暴",
    glyph: "☇",
    color: "magenta",
    a: "#fd79a8",
    b: "#e84393",
  },
  TORNADO,
];

export function levelFor(percent: number): Level {
  return LEVELS.find((level) => percent < level.upTo) ?? TORNADO;
}

/**
 * `$.session.usage()` 的 `context` 变成一次读数。窗口多大还不知道、或者用了多少还不知道(这个窗口里
 * 还没有回应报过用量 —— 续接的会话刚开始时就是这样),都没有读数:宁可先不画,也不把一个有东西的窗口画成空的。
 */
export function readingOf(
  context: { tokens?: number; window?: number; percent?: number } | undefined,
): Reading | undefined {
  if (!context?.window || context.tokens === undefined) return undefined;
  const { tokens, window } = context;
  return { tokens, window, percent: Math.round(context.percent ?? (tokens / window) * 100) };
}

/**
 * 这次请求在服务端跑了几遍。一次请求中途用了服务端的工具(比如问一次「顾问」),模型会在服务端接着再跑一遍,
 * 接口给这次请求报的账是每一遍加起来的:输入那一半差不多正好是窗口的整数倍。
 * 宿主自己的读数是窗口本身(真机 10-05:账上 1 166k,宿主 584k,正好两倍),拿它一比就知道是几遍。
 * 只认「几乎正好是整数倍」:宿主的读数万一落后一步,账会比它大一截但不成倍数,那种照一遍算。
 */
export function passesOf(sent: number, host: number | undefined): number {
  if (!host || host <= 0) return 1;
  const ratio = sent / host;
  const passes = Math.round(ratio);
  return passes >= 2 && Math.abs(ratio - passes) <= 0.1 ? passes : 1;
}

/** 把刚答完的一轮接到后面。 */
export function withTurn(turns: readonly Turn[], next: Turn): Turn[] {
  return [...turns, next].slice(-HISTORY);
}

/**
 * 每根柱子的高度,0 到 1:一轮涨了多少,按图里涨得最多的那一轮缩放。
 * 窗口缩了的那一轮(压缩)是 0,画出来是一截矮桩。
 */
export function barHeights(spent: readonly number[]): number[] {
  const top = Math.max(...spent, 1);
  return spent.map((tokens) => Math.max(0, tokens) / top);
}

/**
 * 两个读数写在卡片上是不是一模一样:百分比、窗口用量、这一轮涨了多少(从 `base` 起算),三处都看。
 * 一样的话就不必换图。
 */
export function readsTheSame(a: Reading, b: Reading, base: number): boolean {
  return (
    a.percent === b.percent &&
    a.window === b.window &&
    short(a.tokens) === short(b.tokens) &&
    spentText(Math.max(0, a.tokens - base)) === spentText(Math.max(0, b.tokens - base))
  );
}

/** 一轮让窗口涨了(压缩的话是落了)多少,带正负号。 */
export function spentText(spent: number): string {
  return spent < 0 ? `−${short(-spent)}` : `+${short(spent)}`;
}

/**
 * `$.session.usage()` 报上来的窗口里,卡片认得的两个:5 小时和 7 天。别的(花费上限、以后新加的)不画。
 * 这一次没带的窗口不出现在结果里 —— 和手上已有的合在一起用(`{ ...已有的, ...这一次的 }`),
 * 一次读数里缺了哪个窗口,那一格留着原来的,不抹掉。
 */
export function limitsOf(
  rateLimits: readonly { kind: string; percentUsed: number; resetsAt?: string }[],
): Limits {
  const out: Limits = {};
  for (const [key, kind] of [
    ["fiveHour", "five_hour"],
    ["sevenDay", "seven_day"],
  ] as const) {
    const found = rateLimits.find((limit) => limit.kind === kind);
    if (found) out[key] = { percent: Math.round(found.percentUsed), resetsAt: found.resetsAt };
  }
  return out;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * 离重置还有多久。写「还剩」而不写几点几分:重置时刻是 UTC 的,mod 跑的环境是哪个时区说不准。
 * 一天以上说天数,不到一天说「时:分」;已经过了就是 0:00;没给重置时刻就什么都不说。
 */
export function remainingOf(resetsAt: string | undefined, now: number): string {
  const at = resetsAt === undefined ? Number.NaN : Date.parse(resetsAt);
  if (Number.isNaN(at)) return "";
  const left = Math.max(0, at - now);
  if (left >= DAY) return `还剩 ${Math.floor(left / DAY)} 天`;
  const minutes = Math.floor(left / 60_000);
  return `还剩 ${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

export function short(n: number): string {
  // 先四舍五入到一位小数再挑单位:999 960 是 1M,不是 1000k。整数不带「.0」:11 980 是 12k。
  const round = (value: number) => (Math.round(value * 10) / 10).toFixed(1).replace(/\.0$/, "");
  if (Math.round(n / 100) >= 10_000) return `${round(n / 1_000_000)}M`;
  if (n >= 1_000) return `${round(n / 1_000)}k`;
  return String(n);
}
