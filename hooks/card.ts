// 桌面应用里那一行额度仪表:一份 SVG 文档。纯函数,读数进、字符串出。
//
// 节点树照设计稿(Claude Design 画布上的仪表那一行)一一对应,三格同构:
// 圆底图标 → 名字和一行小字 → 渐变大数字。上下文那一格多带天气图形和最近几轮;5 小时、本周各占一小格。
// 不画自己的底:垫底的是宿主给这一条画的那块底,BN 的糖果渐变外框和白玻璃片主人都不要。
//
// 颜色写两遍:亮色写成属性(样式表万一被宿主滤掉也还有颜色),暗色在 <style> 里按 prefers-color-scheme 覆盖。
// 动画全在 <style> 里。入场动画的类只在「这次画的和上一次画的不一样」时画上去:
// 读数在回合中间也会落下,所以看的是值变没变,不是有没有回合在跑。
// 环境动画挂在根上的 is-working 底下,回合在跑才动。
// 样式和动画一律写在 <style> 里,不写行内 style:哪一帧延迟多久、虚柱从多高长起,都是生成出来的规则。

import type { Gauge as Shown, Limits, Quota, Turn } from "../types";
import { HISTORY, LEVELS, barHeights, levelFor, remainingOf, short, spentText } from "./forecast";
import type { Level, LevelKey } from "./forecast";

/** 这一行的大小,CSS 像素。沙箱框的高度也用这个数;宽度交给宿主,占满整条。 */
const CARD_WIDTH = 680;
export const CARD_HEIGHT = 56;
const MID = CARD_HEIGHT / 2;
const FONT = "'PingFang SC', 'Microsoft YaHei', 'Source Han Sans', 'Noto Sans CJK', sans-serif";

// 上下文那一格:0 到 330。
const AVATAR_R = 20;
const NAME_X = 52;
const SPARK_PAD = 6;
const BAR_W = 4;
const BAR_PITCH = 6;
const BAR_MAX = 17;
const BAR_MIN = 3;
const SPARK_W = SPARK_PAD * 2 + HISTORY * BAR_W + (HISTORY - 1) * (BAR_PITCH - BAR_W);
const SPARK_X = 330 - SPARK_W;
const SPARK_Y = 10;
const SPARK_H = 36;
const BAR_BOTTOM = SPARK_Y + SPARK_H - 4;
const PERCENT_RIGHT = SPARK_X - 12;

// 两格额度:各宽 150,前面各有一道竖线。只有一个窗口有读数时,它占第一格。
const QUOTA_X = [355, 530] as const;
const QUOTA_W = 150;
const QUOTA_R = 14;

type Gauge = { id: "h" | "w"; label: string; glyph: string; quota: Quota; level: Level };

/**
 * 两格额度圆底里的图形:5 小时是怀表,本周是值班表(主人定的;原先是沙漏和日历)。
 * 画在以圆心为原点的坐标里,白色实心;表针和表上的字用这一档的深色,压在白底上。
 */
const watchGlyph = (ink: string) =>
  '<circle cx="0" cy="-8.2" r="1.6" fill="none" stroke="#fff" stroke-width="1.2"/><rect x="-1.3" y="-6.8" width="2.6" height="2.2" rx="0.7"/><circle cx="0" cy="1.6" r="6.3"/>' +
  `<path d="M0,1.6 L0,-2.4 M0,1.6 L2.8,3.2" fill="none" stroke="${ink}" stroke-width="1.4" stroke-linecap="round"/>`;
const rosterGlyph = (ink: string) =>
  `<rect x="-5.6" y="-6.2" width="11.2" height="13.6" rx="2.2"/><rect x="-2.6" y="-8" width="5.2" height="3" rx="1.2" stroke="${ink}" stroke-width="0.8"/>` +
  `<path d="M-3,-1.4 L3,-1.4 M-3,1.6 L3,1.6 M-3,4.6 L0.8,4.6" fill="none" stroke="${ink}" stroke-width="1.3" stroke-linecap="round"/>`;

function gaugesOf(limits: Limits): Gauge[] {
  const out: Gauge[] = [];
  for (const [id, label, quota, glyph] of [
    ["h", "5 小时", limits.fiveHour, watchGlyph],
    ["w", "本周", limits.sevenDay, rosterGlyph],
  ] as const) {
    if (!quota) continue;
    const level = levelFor(quota.percent);
    out.push({ id, label, glyph: glyph(level.b), quota, level });
  }
  return out;
}

/** 读屏和画不了 Svg 的界面看到的那句话。 */
export function cardAlt(shown: Shown, history: readonly Turn[], limits: Limits): string {
  const { now } = shown;
  const last = history[history.length - 1];
  const context = `${levelFor(now.percent).word}:上下文 ${now.percent}%,${short(now.tokens)} / ${short(now.window)}${last ? `,${spentText(last.spent)}` : ""}`;
  return [
    context,
    ...gaugesOf(limits).map((gauge) => `${gauge.label} ${gauge.quota.percent}%`),
  ].join(";");
}

/**
 * `now` 是带里最新的那个时刻(不一定是这个读数的):循环动画的相位按它算。
 * `fresh` 是「这个读数就是最新的那次变化」:是的话数字滚、柱子长;不是的话(后来别的东西变了,
 * 这张图只是被重新摆上去)什么入场动画都不带,免得每来一次别的更新就重播一遍。
 */
export function cardSvg(
  given: Shown,
  history: readonly Turn[],
  options: { working: boolean; limits: Limits; limitsAt?: number; now: number; fresh: boolean },
): string {
  const shown = options.fresh ? given : { ...given, was: given.now };
  const { now, was } = shown;
  const level = levelFor(now.percent);
  const changed = levelFor(was.percent).key !== level.key;
  const gauges = gaugesOf(options.limits);
  const chart = turns(shown, history, level, options.working);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" role="img" font-family="${FONT}">`,
    `<style>${styleOf(gauges, options.now)}${chart.style}</style>`,
    defs(level, gauges),
    `<g class="cw-card${options.working ? " is-working" : ""}">`,
    avatar(level, changed),
    `<text class="cw-ink${changed ? " cw-rise" : ""}" x="${NAME_X}" y="24" font-size="16" font-weight="700" fill="#18191C">${level.word}</text>`,
    `<text class="cw-sub" x="${NAME_X}" y="44.5" font-size="12" fill="#666">上下文 ${short(now.tokens)} / ${short(now.window)}</text>`,
    roll(
      "l",
      "num",
      "cw-num g-c",
      `x="${PERCENT_RIGHT}" y="38" text-anchor="end" font-size="28" font-weight="700" fill="url(#ink-c-light)"`,
      `${was.percent}%`,
      `${now.percent}%`,
    ),
    chart.body,
    // 「还剩多久」从额度读数的那一刻算,不从窗口读数的那一刻:两样不是一起读的。
    ...QUOTA_X.flatMap((x, i) => {
      const gauge = gauges[i];
      return gauge ? [quota(gauge, x, options.limitsAt ?? shown.at)] : [];
    }),
    "</g></svg>",
  ].join("");
}

/** 一格用到的三样渐变:圆底、亮色下的大数字、暗色下的大数字。 */
function gradientsOf(id: string, level: Level): string {
  return [
    `<linearGradient id="ava-${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${level.a}"/><stop offset="1" stop-color="${level.b}"/></linearGradient>`,
    // 大数字的渐变照 SC 金额的做法,但压在深的那一头,保证浅底上看得清。
    `<linearGradient id="ink-${id}-light" x1="0" y1="0" x2="1" y2="1"><stop offset="0.35" stop-color="${level.b}"/><stop offset="1" stop-color="${mix(level.b, level.a, 0.68)}"/></linearGradient>`,
    `<linearGradient id="ink-${id}-dark" x1="0" y1="0" x2="1" y2="1"><stop offset="0.25" stop-color="${level.a}"/><stop offset="1" stop-color="${mix(level.a, level.b, 0.6)}"/></linearGradient>`,
  ].join("");
}

function defs(level: Level, gauges: readonly Gauge[]): string {
  return `<defs>${gradientsOf("c", level)}${gauges.map((gauge) => gradientsOf(gauge.id, gauge.level)).join("")}<clipPath id="disc"><circle r="${AVATAR_R}"/></clipPath>${ROLL_CLIPS}</defs>`;
}

// 滚动的数字各自的裁切框:大百分比那一块,和柱子上方那个数的那一条。
const ROLL_CLIPS =
  `<clipPath id="clip-num"><rect x="${PERCENT_RIGHT - 100}" y="13" width="100" height="31"/></clipPath>` +
  `<clipPath id="clip-spent"><rect x="${SPARK_X}" y="${SPARK_Y + 1}" width="${SPARK_W}" height="12"/></clipPath>`;

const CLOUD =
  '<circle cx="-5.5" cy="2.5" r="5.5"/><circle cx="1" cy="-2" r="7.5"/><circle cx="8" cy="3" r="5"/><rect x="-5.5" y="2.5" width="13.5" height="5.5" rx="1"/>';

const RAYS = Array.from(
  { length: 8 },
  (_, k) =>
    `<rect x="-1.5" y="-16" width="3" height="5.5" rx="1.5" transform="rotate(${k * 45})"/>`,
).join("");

const DROPS = ([-6, 0.5, 7] as const)
  .map(
    (x, i) =>
      `<g transform="translate(${x} 6.5) rotate(16)"><rect class="cw-rain d${i}" x="-1" width="2" height="5.5" rx="1"/></g>`,
  )
  .join("");

const STORM_DROPS = ([-8.5, 10.5] as const)
  .map(
    (x, i) =>
      `<g transform="translate(${x} 6.5) rotate(16)"><rect class="cw-rain d${i}" x="-1" width="2" height="5.5" rx="1"/></g>`,
  )
  .join("");

const FUNNEL = ([24, 19, 14.5, 10.5, 7, 4] as const)
  .map(
    (width, i) =>
      `<rect class="cw-funnel f${i}" x="${-width / 2}" y="${-13 + i * 5}" width="${width}" height="3.6" rx="1.8"/>`,
  )
  .join("");

/** 头像里的白色实心图形,画在以圆心为原点、半径 22 的坐标里(用的时候缩到头像的半径)。 */
const SCENES: Record<LevelKey, string> = {
  clear: `<g class="cw-spin">${RAYS}</g><circle class="cw-breathe" r="7"/>`,
  cloudy:
    `<g class="cw-drift"><g opacity="0.55" transform="translate(-5 -8) scale(0.62)">${CLOUD}</g></g>` +
    `<g class="cw-bob"><g transform="translate(-1 3)">${CLOUD}</g></g>`,
  showers: `<g class="cw-bob"><g transform="translate(-1 -4.5)">${CLOUD}</g></g>${DROPS}`,
  // 雷暴不闪:闪电一直在,隔一阵缩回云里再劈下来,云跟着抖两下。只动位置和大小,不动透明度。
  storm:
    `<g class="cw-rumble"><g class="cw-bob"><g transform="translate(-1 -4.5)">${CLOUD}</g></g></g>` +
    STORM_DROPS +
    '<polygon class="cw-strike" points="2.5,3.5 -3.5,11.5 0.5,11.5 -1.5,18.5 6,9 2,9 4.5,3.5" fill="#fdcb6e"/>',
  // 龙卷风:一摞越往下越窄的横条,自上而下错开着左右甩,整根来回歪;两粒被卷起来的碎屑。
  tornado:
    `<g class="cw-lean">${FUNNEL}</g>` +
    '<circle class="cw-debris" cx="-12" cy="9" r="1.4"/><circle class="cw-debris d1" cx="12.5" cy="2" r="1.1"/>',
};

function avatar(level: Level, pop: boolean): string {
  const rings =
    level.key === "tornado"
      ? `<circle class="cw-ring" r="${AVATAR_R}" fill="${level.b}" opacity="0"/><circle class="cw-ring cw-ring2" r="${AVATAR_R}" fill="${level.b}" opacity="0"/>`
      : "";
  const face = `<circle r="${AVATAR_R}" fill="url(#ava-c)"/><g clip-path="url(#disc)" fill="#fff"><g transform="scale(${AVATAR_R / 22})">${SCENES[level.key]}</g></g>`;
  // 干活时只让图形自己动,头像上不另加记号:右下角原先有一颗小粉点,主人不要。
  return `<g transform="translate(${AVATAR_R} ${MID})">${rings}${pop ? `<g class="cw-pop">${face}</g>` : face}</g>`;
}

/**
 * 最近几轮:一轮一根,高度是那一轮让窗口涨了多少,颜色是那一轮答完时的档。
 * 正在跑的这一轮是一根虚柱,跟着读数长高;还没有的轮次是一道短槽。
 * 上面那个数是这一轮已经涨了多少,没有回合在跑时是上一轮的。
 */
function turns(
  shown: Shown,
  history: readonly Turn[],
  level: Level,
  working: boolean,
): { body: string; style: string } {
  const live = working ? Math.max(0, shown.now.tokens - shown.base) : undefined;
  // 虚柱要占一格:满了的话最旧的那一轮让出来。
  const done = history.slice(-(working ? HISTORY - 1 : HISTORY));
  const heights = barHeights([
    ...done.map((turn) => turn.spent),
    ...(live === undefined ? [] : [live]),
  ]);
  const heightAt = (i: number) => Math.max(BAR_MIN, Math.round((heights[i] ?? 0) * BAR_MAX));
  const last = done[done.length - 1];
  // 刚答完的那一轮,上一次画的时候(还在跑)涨到了多少:答完那一下,上方的数从它滚到终值,柱子从它长到终高。
  // 那一轮的起点是「此刻的读数减去它涨的」;上一次画的就是此刻的话,这个数等于终值,什么都不动。
  const landedFrom = last ? Math.max(0, shown.was.tokens - (shown.now.tokens - last.spent)) : 0;
  const spentAttrs = `x="${SPARK_X + SPARK_W - SPARK_PAD}" y="${SPARK_Y + 11}" text-anchor="end" font-size="10" font-weight="700" fill="#666"`;
  let style = "";
  const out = [
    `<rect class="cw-tint" x="${SPARK_X}" y="${SPARK_Y}" width="${SPARK_W}" height="${SPARK_H}" rx="8" fill="#000" fill-opacity="0.05"/>`,
  ];

  if (live !== undefined) {
    out.push(
      roll(
        "s",
        "spent",
        "cw-spent cw-sub",
        spentAttrs,
        spentText(Math.max(0, shown.was.tokens - shown.base)),
        spentText(live),
      ),
    );
  } else if (last) {
    out.push(
      roll(
        "s",
        "spent",
        "cw-spent cw-sub",
        spentAttrs,
        spentText(landedFrom),
        spentText(last.spent),
      ),
    );
  }
  for (let i = 0; i < HISTORY; i++) {
    const x = SPARK_X + SPARK_PAD + i * BAR_PITCH;
    const turn = done[i];
    if (turn) {
      const height = heightAt(i);
      let stretch = "";
      if (live === undefined && i === done.length - 1) {
        const from = Math.max(
          BAR_MIN,
          Math.round((landedFrom / Math.max(...done.map((turn) => turn.spent), 1)) * BAR_MAX),
        );
        if (from !== height) {
          stretch = " cw-stretch";
          style = `@keyframes cw-stretch{from{transform:scaleY(${(from / height).toFixed(3)})}to{transform:scaleY(1)}}`;
        }
      }
      out.push(
        `<rect class="cw-bar lv-${levelFor(turn.percent).key}${stretch}" x="${x}" y="${BAR_BOTTOM - height}" width="${BAR_W}" height="${height}" rx="2" fill="${levelFor(turn.percent).b}"/>`,
      );
    } else if (i === done.length && live !== undefined) {
      const height = heightAt(i);
      // 上一次画的时候它多高(按这一次的比例尺):不一样就从那儿长过来。
      const from = Math.max(
        BAR_MIN,
        Math.round(
          (Math.max(0, shown.was.tokens - shown.base) /
            Math.max(live, ...done.map((turn) => turn.spent), 1)) *
            BAR_MAX,
        ),
      );
      const stretch = from === height ? "" : " cw-stretch";
      if (stretch) {
        style = `@keyframes cw-stretch{from{transform:scaleY(${(from / height).toFixed(3)})}to{transform:scaleY(1)}}`;
      }
      out.push(
        `<rect class="cw-ghost lv-${level.key}${stretch}" x="${x}" y="${BAR_BOTTOM - height}" width="${BAR_W}" height="${height}" rx="2" fill="${level.b}" opacity="0.45"/>`,
      );
    } else {
      out.push(
        `<rect class="cw-track" x="${x}" y="${BAR_BOTTOM - 3}" width="${BAR_W}" height="3" rx="1.5" fill="#000" fill-opacity="0.08"/>`,
      );
    }
  }
  return { body: out.join(""), style };
}

/**
 * 一个会滚的数。没变就是一行字;变了就是两行:旧值向上滑出裁切框,新值从下面滑进来。
 * 只动位置,不动透明度 —— 真机上试过靠几帧明灭来「数」,看上去是疯狂地闪。
 * `size` 是滑多远:大数字滑一个大字的高度(l),小数字滑一个小字的高度(s)。
 */
function roll(
  size: "l" | "s",
  clip: "num" | "spent",
  cls: string,
  attrs: string,
  was: string,
  now: string,
): string {
  if (was === now) return `<text class="${cls}" ${attrs}>${now}</text>`;
  return `<g class="cw-roll-${size}" clip-path="url(#clip-${clip})"><text class="${cls} cw-out" ${attrs}>${was}</text><text class="${cls} cw-in" ${attrs}>${now}</text></g>`;
}

/** 一格额度:前面一道竖线,圆底图标、名字、离重置还有多久、渐变的百分比。 */
function quota(gauge: Gauge, x: number, now: number): string {
  const left = remainingOf(gauge.quota.resetsAt, now);
  const textX = x + QUOTA_R * 2 + 10;
  return [
    `<rect class="cw-divider" x="${x - 13}" y="12" width="1" height="32" fill="#000" fill-opacity="0.08"/>`,
    `<circle cx="${x + QUOTA_R}" cy="${MID}" r="${QUOTA_R}" fill="url(#ava-${gauge.id})"/>`,
    `<g transform="translate(${x + QUOTA_R} ${MID})" fill="#fff">${gauge.glyph}</g>`,
    `<text class="cw-ink" x="${textX}" y="${left ? 24 : 32.5}" font-size="13" font-weight="700" fill="#18191C">${gauge.label}</text>`,
    left
      ? `<text class="cw-sub" x="${textX}" y="41.5" font-size="11" fill="#666">${left}</text>`
      : "",
    `<text class="cw-num g-${gauge.id}" x="${x + QUOTA_W}" y="35" text-anchor="end" font-size="20" font-weight="700" fill="url(#ink-${gauge.id}-light)">${gauge.quota.percent}%</text>`,
  ].join("");
}

// 入场都用强的 ease-out、0.26 秒以内;循环的用 linear 或 ease-in-out。
const EASE_OUT = "cubic-bezier(0.23,1,0.32,1)";

function styleOf(gauges: readonly Gauge[], now: number): string {
  const dark = [
    ".cw-ink{fill:#fff}",
    ".cw-sub{fill:#fff;fill-opacity:.68}",
    ".cw-tint{fill:#fff;fill-opacity:.07}",
    ".cw-track{fill:#fff;fill-opacity:.14}",
    ".cw-divider{fill:#fff;fill-opacity:.1}",
    ...["c", ...gauges.map((gauge) => gauge.id)].map((id) => `.g-${id}{fill:url(#ink-${id}-dark)}`),
    ...LEVELS.map((level) => `.lv-${level.key}{fill:${level.a}}`),
  ].join("");
  return [
    // 配色方案两样都认:画在沙箱框里时,和宿主页面不一致会被铺一层不透明的白底,宿主的底就透不出来了。
    ":root{color-scheme:light dark}",
    "text{font-variant-numeric:tabular-nums}",
    `@media (prefers-color-scheme:dark){${dark}}`,
    // 读数一落下,整张图就换一份新的,循环动画会从头来。让它们从「读数那一刻是这一小时里的第几毫秒」起步,
    // 换图前后相位就接得上:太阳不会每读一次数就跳回原位。
    // 用的是读数的时刻,不是画的时刻:同一个读数不管重画几次都是同一张图,宿主没有东西可换。
    `.cw-card{--at:-${now % 3_600_000}ms}`,
    MOTION,
  ].join("");
}

const MOTION = [
  // 头像里绕圆心转、绕圆心缩放、绕圆心歪的那些,轴就是头像那一组的原点;其余的绕自己。
  ".cw-pop,.cw-spin,.cw-breathe,.cw-lean,.cw-ring{transform-origin:0 0}",
  // 闪电从云底劈下来,虚柱从底往上长。
  ".cw-strike{transform-box:fill-box;transform-origin:50% 0}",
  ".cw-stretch{transform-box:fill-box;transform-origin:50% 100%}",
  "@keyframes cw-pop{from{transform:scale(.9);opacity:0}to{transform:scale(1);opacity:1}}",
  "@keyframes cw-rise{from{transform:translateY(6px);opacity:0}to{transform:translateY(0);opacity:1}}",
  "@keyframes cw-fade{from{opacity:0}to{opacity:1}}",
  "@keyframes cw-out-l{from{opacity:1;transform:translateY(0)}to{opacity:1;transform:translateY(-32px)}}",
  "@keyframes cw-in-l{from{transform:translateY(32px)}to{transform:translateY(0)}}",
  "@keyframes cw-out-s{from{opacity:1;transform:translateY(0)}to{opacity:1;transform:translateY(-13px)}}",
  "@keyframes cw-in-s{from{transform:translateY(13px)}to{transform:translateY(0)}}",
  "@keyframes cw-spin{to{transform:rotate(360deg)}}",
  "@keyframes cw-breathe{from{transform:scale(1)}to{transform:scale(1.12)}}",
  "@keyframes cw-drift{from{transform:translateX(26px)}to{transform:translateX(-30px)}}",
  "@keyframes cw-bob{from{transform:translateY(-1px)}to{transform:translateY(1.5px)}}",
  "@keyframes cw-rain{0%{transform:translateY(-4px);opacity:0}20%{opacity:1}80%{opacity:1}100%{transform:translateY(5px);opacity:0}}",
  "@keyframes cw-strike{0%,60%,100%{transform:scaleY(1)}68%{transform:scaleY(.3)}76%{transform:scaleY(1.14)}84%{transform:scaleY(1)}}",
  "@keyframes cw-rumble{0%,66%,100%{transform:translateX(0)}72%{transform:translateX(-1.3px)}78%{transform:translateX(1.3px)}84%{transform:translateX(-.6px)}90%{transform:translateX(0)}}",
  "@keyframes cw-sway{from{transform:translateX(-2.6px)}to{transform:translateX(2.6px)}}",
  "@keyframes cw-lean{from{transform:rotate(-7deg)}to{transform:rotate(7deg)}}",
  "@keyframes cw-fling{from{transform:translate(0,0)}to{transform:translate(5px,-4px)}}",
  "@keyframes cw-ripple{from{transform:scale(1);opacity:.45}to{transform:scale(1.45);opacity:0}}",
  "@keyframes cw-ghost{from{opacity:.25}to{opacity:.7}}",
  `.cw-pop{animation:cw-pop .22s ${EASE_OUT} both}`,
  `.cw-rise{animation:cw-rise .2s ${EASE_OUT} both}`,
  // 滚动的数:滑出去的那一行平时看不见,只在滑的那一下看得见(滑完已经在裁切框外面了)。
  ".cw-out{opacity:0}",
  `.cw-roll-l .cw-out{animation:cw-out-l .26s ${EASE_OUT}}`,
  `.cw-roll-l .cw-in{animation:cw-in-l .26s ${EASE_OUT} both}`,
  `.cw-roll-s .cw-out{animation:cw-out-s .26s ${EASE_OUT}}`,
  `.cw-roll-s .cw-in{animation:cw-in-s .26s ${EASE_OUT} both}`,
  ".is-working .cw-spin{animation:cw-spin 14s linear var(--at) infinite}",
  ".is-working .cw-breathe{animation:cw-breathe 1.8s ease-in-out var(--at) infinite alternate}",
  ".is-working .cw-drift{animation:cw-drift 7s linear var(--at) infinite}",
  ".is-working .cw-bob{animation:cw-bob 2.4s ease-in-out var(--at) infinite alternate}",
  ".is-working .cw-rain{animation:cw-rain 1s linear var(--at) infinite}",
  ".is-working .cw-rain.d1{animation-delay:calc(var(--at) + .33s)}",
  ".is-working .cw-rain.d2{animation-delay:calc(var(--at) + .66s)}",
  ".is-working .cw-strike{animation:cw-strike 2.6s ease-in-out var(--at) infinite}",
  ".is-working .cw-rumble{animation:cw-rumble 2.6s linear var(--at) infinite}",
  ".is-working .cw-funnel{animation:cw-sway .64s ease-in-out var(--at) infinite alternate}",
  ...Array.from(
    { length: 6 },
    (_, i) =>
      `.is-working .cw-funnel.f${i}{animation-delay:calc(var(--at) + ${(i * 0.11).toFixed(2)}s)}`,
  ).slice(1),
  ".is-working .cw-lean{animation:cw-lean 2.2s ease-in-out var(--at) infinite alternate}",
  ".is-working .cw-debris{animation:cw-fling .5s ease-in-out var(--at) infinite alternate}",
  ".is-working .cw-debris.d1{animation-direction:alternate-reverse}",
  `.is-working .cw-ring{animation:cw-ripple 1.8s ${EASE_OUT} var(--at) infinite}`,
  ".is-working .cw-ring2{animation-delay:calc(var(--at) + .9s)}",
  ".is-working .cw-ghost{animation:cw-ghost .9s ease-in-out var(--at) infinite alternate}",
  `.cw-bar.cw-stretch{animation:cw-stretch .26s ${EASE_OUT} both}`,
  `.is-working .cw-ghost.cw-stretch{animation:cw-ghost .9s ease-in-out var(--at) infinite alternate,cw-stretch .26s ${EASE_OUT} both}`,
  // 减少动态效果:位移和缩放都不要,入场只留淡入;滚动的数直接是新值。
  "@media (prefers-reduced-motion:reduce){.cw-card *{animation:none !important}.cw-card .cw-pop,.cw-card .cw-rise{animation:cw-fade .2s ease both !important}}",
].join("");

/** 两个十六进制颜色按比例混:t 为 0 是 `from`,为 1 是 `to`。 */
function mix(from: string, to: string, t: number): string {
  const channel = (hex: string, i: number) => Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  const out = [0, 1, 2].map((i) =>
    Math.round(channel(from, i) + (channel(to, i) - channel(from, i)) * t),
  );
  return `#${out.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}
