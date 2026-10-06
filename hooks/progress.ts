// 进度行:伦伦酱用「报进度」工具报上来的活,一件一行,排在仪表上面;派出去的子代理也各占一行,排在最上面。
// 纯函数,报告进、行出,行进、SVG 出。
//
// 一件活分几个阶段,每个阶段几步;报上来的是「一共做完了几步」。
// 四种状态各有图标和颜色:勘察阶段(蓝,放大镜)、工作中(粉,齿轮)、等你拍板(黄,服务铃)、做完了(绿,对勾)。
// 状态由步数推:做满了是做完,正做的阶段是勘察类就是勘察,其余是工作中。只有「等拍板」推不出来,要报的人明说,
// 而且每次都要说 —— 下一次没说就回到推出来的那个。
//
// 画法照设计稿(Claude Design 画布上的进度行),和仪表同一套语汇:
// 不画自己的底,亮色写成属性、暗色在 <style> 里覆盖,动画只在「这次画的和上一次不一样」时带上,样式全写在 <style> 里。

import type { Agent, Phase, Row, RowStatus } from "../types";

/** 记着的行最多几行,记着的都画:再多,最久没报的让出来(报的人跑偏了也不至于把屏幕占满)。 */
export const KEPT = 10;
/** 子代理最多记几个:再多,最久没动静的让出来。 */
export const AGENTS_KEPT = 6;
/**
 * 整条带多久没人报就算都不做了,下一轮开始时一起收起。按整条带最近一次有人报来算,不按每一行各自的:
 * 报上来的行是一层一层的(总进度、这一期、手上这一片),总进度那样的行本来就好几天才动一下,
 * 各算各的话它会被单独收走(原先一小时、后来一天,真机上总进度被收走过)。
 * 七天(主人定的):行落了盘、跨着应用重启也留着,歇个周末回来还得在。计划改了该撤的行,报的人自己撤。
 */
export const STALE = 7 * 24 * 60 * 60_000;
/** 一个会话多久没人报过进度,盘上它那份就清掉:多半不会再续了,而盘上的总量有上限,不清迟早写不进去。 */
export const FORGOTTEN = 30 * 24 * 60 * 60_000;
/** 子代理多久没动静就算没了(被杀掉的等不到收场)。它一次请求不会这么久。 */
export const AGENT_STALE = 60 * 60_000;
/** 一件活最多几步、几个阶段,阶段名最多几个字:再多,轨道上画不下。 */
const MAX_STEPS = 100;
const MAX_PHASES = 8;
const NAME_CHARS = 6;
/** 一步窄于这么多像素就不画小刻度,免得糊成一片。 */
const TICK_ROOM = 6;
/** 小箭头前后尽量隔这么远(主人看过:8 步的行 54 宽里四只,这个密度正好),只数取最接近的整数。 */
const WALK_GAP = 13.5;
/** 但绝不比这更密:再近就嫌挤(隔 6 的、三只挤成一团的,主人都看过;13 步的行一格 33 宽,三只隔 11 和两只比过,主人要两只)。连一只都放不下的格子不画箭头。 */
const WALK_TIGHT = 12;
/** 小箭头每秒走这么远,格子宽窄都是这个速度:一趟的时间定死的话,宽格子里快、窄格子里慢(主人看过)。 */
const WALK_SPEED = 24;
/** 小箭头从胶囊底下钻出来:起步的地方比它停着的位置靠左这么多。 */
const WALK_IN = 8;
/** 小箭头在路的两头各用这么长淡入淡出;路短的话最多各占一趟的两成。 */
const WALK_FADE = 7;
export const ROW_HEIGHT = 28;

const ROW_WIDTH = 680;
const FONT = "'PingFang SC', 'Microsoft YaHei', 'Source Han Sans', 'Noto Sans CJK', sans-serif";
const EASE_IN_OUT = "cubic-bezier(0.77,0,0.175,1)";

const DISC = 10;
const TITLE_X = 28;
const TITLE_CHARS = 11;
const TRACK_X = 188;
const TRACK_W = 432;
const TRACK_Y = 5;
const TRACK_H = 18;

type Look = { word: string; from: string; to: string; pill: string; ink: string; disc: string };

const LOOKS: Record<RowStatus, Look> = {
  survey: {
    word: "勘察阶段",
    from: "#74b9ff",
    to: "#0984e3",
    pill: "#0984e3",
    ink: "#fff",
    disc: "url(#pr-disc)",
  },
  working: {
    word: "工作中",
    from: "#fd79a8",
    to: "#e84393",
    pill: "#FF6699",
    ink: "#fff",
    disc: "url(#pr-disc)",
  },
  decide: {
    word: "等你拍板",
    from: "#fdcb6e",
    to: "#e17055",
    pill: "#fdcb6e",
    ink: "#18191C",
    disc: "#fdcb6e",
  },
  done: {
    word: "做完了",
    from: "#a8e6cf",
    to: "#88d8b0",
    pill: "#88d8b0",
    ink: "#18191C",
    disc: "#88d8b0",
  },
};

/** 齿轮的八个齿。 */
const TEETH = Array.from(
  { length: 8 },
  (_, k) =>
    `<rect x="-1.3" y="-6.8" width="2.6" height="3.2" rx="0.8" transform="rotate(${k * 45})"/>`,
).join("");

/**
 * 圆底里的图形,画在以圆心为原点的坐标里。工作中是齿轮,等你拍板是服务铃,勘察是放大镜,做完是对勾。
 * 工作中试过扫帚:图标太小,看不出是什么,主人说换回齿轮。
 * 会动的那一层自己不带 transform 属性(CSS 的 transform 会盖掉它),位置由外面一层 <g> 管。
 */
const ICONS: Record<RowStatus, string> = {
  survey:
    '<g class="pr-icon i-survey" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round"><circle cx="-1.2" cy="-1.2" r="3.4"/><path d="M1.4,1.4 L4.6,4.6"/></g>',
  // 齿轮:回合跑着的时候转。
  working: `<g class="pr-icon i-working" fill="#fff">${TEETH}<path fill-rule="evenodd" d="M0,-4.6 A4.6,4.6 0 1 0 0,4.6 A4.6,4.6 0 1 0 0,-4.6 Z M0,-1.8 A1.8,1.8 0 1 1 0,1.8 A1.8,1.8 0 1 1 0,-1.8 Z"/></g>`,
  // 服务铃:隔一阵摇两下,贴着铃肩的两道弧线跟着亮。等着的时候也摇,不看回合在不在跑 —— 它就是在叫主人。
  decide:
    '<g class="pr-icon i-decide"><g transform="translate(0 5)"><g class="pr-ring" fill="#18191C">' +
    '<path d="M-5.2,-2.4 a5.2,5.6 0 0 1 10.4,0 z"/><rect x="-6.4" y="-1.9" width="12.8" height="1.9" rx="0.9"/><circle cy="-8.9" r="1.2"/></g></g>' +
    '<path class="pr-ringmark" d="M-6.95,-0.86 A7.2,7.2 0 0 1 -4.63,-4.52" fill="none" stroke="#18191C" stroke-width="1.3" stroke-linecap="round"/>' +
    '<path class="pr-ringmark" d="M6.95,-0.86 A7.2,7.2 0 0 0 4.63,-4.52" fill="none" stroke="#18191C" stroke-width="1.3" stroke-linecap="round"/></g>',
  done: '<g class="pr-icon i-done" fill="none" stroke="#18191C" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M-3.8,0.2 L-1.2,2.8 L3.9,-2.6"/></g>',
};

export function totalOf(phases: readonly Phase[]): number {
  return phases.reduce((sum, phase) => sum + phase.steps, 0);
}

/** 正在做的是哪个阶段、它前面做满了几个阶段、它自己做完了几步;整件活做满了就没有。 */
function currentOf(row: Row): { phase: Phase; phasesDone: number; stepsDone: number } | undefined {
  let before = 0;
  for (const [i, phase] of row.phases.entries()) {
    if (row.done < before + phase.steps)
      return { phase, phasesDone: i, stepsDone: row.done - before };
    before += phase.steps;
  }
  return undefined;
}

export function statusOf(row: Row): RowStatus {
  const current = currentOf(row);
  if (!current) return "done";
  return row.status ?? (current.phase.survey ? "survey" : "working");
}

/**
 * 行尾那个数:整件活做完了多少,分母是整件活,不是眼下这个阶段(「2期 1/1」那样的没有意思,主人指出来的)。
 * 数的是做完的,不是「正在做第几个」:后一种写法开工时就是 1/4,旁边的百分比却是 0%,看着像做完了一步
 * (原先就是那样写的,主人指出来的)。
 * - 只有一个阶段:做完几步 / 一共几步,「9/18」。
 * - 好几个阶段、眼下这个只有一步:做完几个阶段 / 一共几个阶段,「1/7」。
 * - 好几个阶段、眼下这个还分步:做完几个阶段.眼下这个阶段做完几步 / 一共几个阶段,「1.2/3」。
 *   阶段那一位也数做完的:写成「第几个阶段」的话,最后一个阶段刚开始就是 3.0/3,看着像全做完了。
 * 带不带小数只看眼下这个阶段,不看别的阶段:原先只要有一个阶段分步就全都带,只有一步的阶段成了
 * 「首个提交 3.0/4」,那个 .0 什么也没说(主人指出来的)。
 * 做满了就是分母比分母。
 */
function countOf(row: Row): string {
  const current = currentOf(row);
  const phases = row.phases.length;
  if (phases === 1) {
    const steps = totalOf(row.phases);
    return `${current ? current.stepsDone : steps}/${steps}`;
  }
  if (!current) return `${phases}/${phases}`;
  const stepped = current.phase.steps > 1;
  return `${stepped ? `${current.phasesDone}.${current.stepsDone}` : current.phasesDone}/${phases}`;
}

/** 写成一句话的地方(回执、读屏、终端那一行)用的:正在做的阶段名加上面那个数;做满了是「完成」。 */
function labelOf(row: Row): string {
  return `${currentOf(row)?.phase.name ?? "完成"} ${countOf(row)}`;
}

function percentOf(row: Row): number {
  return Math.round((row.done / totalOf(row.phases)) * 100);
}

/**
 * 胶囊上的字:正在做的那个阶段的名字,做满了是「完成」。数字在行尾。
 * 胶囊的右端贴着进度头,刚跨进一个阶段时人还趴在上一段里(主人指出来的):名字一明一暗,说的是「这个还没做完」。
 * 试过写成「1期 → 2期」,主人看了真带子之后不要。
 */
function pillOf(row: Row): string {
  return currentOf(row)?.phase.name ?? "完成";
}

/**
 * 把报上来的东西看一遍:合规就是一行(步数报多了按做满算),不合规就是一句为什么。
 * 报的人是模型,形状可能不对,所以每样都验。
 */
export function rowOf(input: Record<string, unknown>): Omit<Row, "was" | "at"> | string {
  const { plan, title, phases, done, status } = input;
  if (typeof plan !== "string" || !plan || typeof title !== "string" || !title)
    return "plan 和 title 都要有";
  if (!Array.isArray(phases) || phases.length === 0) return "phases 至少要有一个阶段";
  if (phases.length > MAX_PHASES) return `阶段最多 ${MAX_PHASES} 个`;
  const list: Phase[] = [];
  for (const phase of phases as Record<string, unknown>[]) {
    if (typeof phase?.name !== "string" || !phase.name) return "每个阶段都要有 name";
    if (typeof phase.steps !== "number" || !Number.isInteger(phase.steps) || phase.steps < 1)
      return "每个阶段的 steps 要是正整数";
    const name = [...phase.name].slice(0, NAME_CHARS).join("");
    list.push(
      phase.survey === true
        ? { name, steps: phase.steps, survey: true }
        : { name, steps: phase.steps },
    );
  }
  if (totalOf(list) > MAX_STEPS)
    return `一件活最多 ${MAX_STEPS} 步(现在是 ${totalOf(list)} 步),把步子并大一些`;
  if (typeof done !== "number" || !Number.isInteger(done) || done < 0)
    return "done 要是不小于 0 的整数";
  const said =
    status === "survey" || status === "working" || status === "decide" || status === "done"
      ? status
      : undefined;
  const row = { plan, title, phases: list, done: Math.min(done, totalOf(list)) };
  return said ? { ...row, status: said } : row;
}

/**
 * 一次报告落到行上。同一件活(plan 相同)换掉原来那行,位置不动(行不会因为报了一次就跳到别处);
 * 新的活排在最后;画出来一模一样的报告不动任何东西。
 * 「上一次画的步数」记下来,条和胶囊从那儿滑过来;头一回报就从 0 长出来。
 */
export function withReport(
  rows: readonly Row[],
  report: Omit<Row, "was" | "at">,
  at: number,
): Row[] {
  const old = rows.find((row) => row.plan === report.plan);
  if (
    old &&
    JSON.stringify({ ...report, was: old.was, at: old.at }) ===
      JSON.stringify({ ...old, status: old.status })
  ) {
    return rows as Row[];
  }
  const next = { ...report, was: old?.done ?? 0, at };
  if (old) return rows.map((row) => (row === old ? next : row));
  // 新的一件活:记着的行满了,最久没报的那一行让出来。
  const kept =
    rows.length >= KEPT
      ? [...rows].sort((a, b) => a.at - b.at).slice(rows.length - KEPT + 1)
      : rows;
  return [...rows.filter((row) => kept.includes(row)), next];
}

/** 整条带太久没人报就全收起来;还有哪一行最近报过,就一行都不收。什么都不用收时原样交回。 */
export function withoutStale(rows: readonly Row[], now: number): Row[] {
  return rows.length === 0 || rows.some((row) => now - row.at <= STALE) ? (rows as Row[]) : [];
}

/** 一行里要落盘的那些:「上一次画的步数」不算 —— 它只管条从哪儿滑过来,每轮都在变,不值得为它写一次盘。 */
export function keptOf(rows: readonly Row[]): Omit<Row, "was">[] {
  return rows.map(({ was: _was, ...row }) => row);
}

/**
 * 盘上读回来的东西还原成行。盘上的可能是以前的版本写的,也可能被别的东西动过,所以和模型报上来的一样每样都验:
 * 读不成一行的丢掉,其余照收;再多也只收记得下的那么多,靠后的(后报的)留下。
 * 条和胶囊直接落在做到的地方,不从头滑一遍。
 */
export function rowsFrom(saved: unknown): Row[] {
  if (!Array.isArray(saved)) return [];
  const rows: Row[] = [];
  for (const item of saved as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const row = rowOf(item as Record<string, unknown>);
    const { at } = item as { at?: unknown };
    if (typeof row !== "string" && typeof at === "number" && Number.isFinite(at))
      rows.push({ ...row, was: row.done, at });
  }
  return rows.slice(-KEPT);
}

/** 盘上一个会话的行是不是没人管了:一行都读不出来,或者每一行都太久没人报。 */
export function isForgotten(rows: readonly Row[], now: number): boolean {
  return rows.every((row) => now - row.at > FORGOTTEN);
}

/**
 * 带里从上到下的顺序:先报的在下、后报的在上。报的人先报大的(总进度)再报细的,
 * 于是最下面是总进度,越往上越细,新开的一小件活长在最上面。
 */
export function shownRows(rows: readonly Row[]): Row[] {
  return [...rows].reverse();
}

/** 等拍板的行回到由步数推出来的状态(主人发话了)。什么都不用改时原样交回。 */
export function withoutDecide(rows: readonly Row[]): Row[] {
  return rows.some((row) => row.status === "decide")
    ? (rows.map(({ status, ...row }) => (status === "decide" ? row : { ...row, status })) as Row[])
    : (rows as Row[]);
}

// ---- 子代理的行 ----

/** 派出去一个:记一行。同一个 id 再派(续上)就接着原来那行。 */
export function withSpawn(
  agents: readonly Agent[],
  id: string,
  title: string,
  at: number,
): Agent[] {
  const old = agents.find((agent) => agent.id === id);
  if (old)
    return agents.map((agent) =>
      agent === old
        ? { id, title: title || old.title, steps: old.steps, since: old.since, at }
        : agent,
    );
  const kept =
    agents.length >= AGENTS_KEPT
      ? [...agents].sort((a, b) => a.at - b.at).slice(agents.length - AGENTS_KEPT + 1)
      : agents;
  return [
    ...agents.filter((agent) => kept.includes(agent)),
    { id, title: title || "子代理", steps: 0, since: at, at },
  ];
}

/**
 * 它发完了一次模型请求。没见过它派出去(热加载之前派的)也给它一行;跑完又被叫回来干活的(新的一轮),重新算在跑。
 * 已经收场的那一轮迟到的请求只记数,不算它又跑起来:最后一次请求的收尾和那一轮的收场谁先写不一定,
 * 不分的话跑完的行会被改回「在跑」,再也等不到收场(真机上撞过)。
 */
export function withAgentStep(
  agents: readonly Agent[],
  id: string,
  turnId: string,
  at: number,
): Agent[] {
  const known = agents.some((agent) => agent.id === id)
    ? (agents as Agent[])
    : withSpawn(agents, id, "", at);
  return known.map((agent) => {
    if (agent.id !== id) return agent;
    if (agent.ended && agent.endedTurn === turnId) return { ...agent, steps: agent.steps + 1 };
    return { id, title: agent.title, steps: agent.steps + 1, since: agent.since, at };
  });
}

/** 它这一轮跑完了:做完,或者停了(被打断、出错)。 */
export function withAgentEnd(
  agents: readonly Agent[],
  id: string,
  ended: "done" | "stopped",
  turnId: string,
  at: number,
): Agent[] {
  return agents.map((agent) =>
    agent.id === id
      ? {
          id,
          title: agent.title,
          steps: agent.steps,
          since: agent.since,
          at,
          ended,
          endedTurn: turnId,
        }
      : agent,
  );
}

/**
 * 主循环的一轮答完:跑完的子代理收起。它跑完会开出一轮来听回报,那一轮里主人看得到「做完了」,
 * 答完就不用再占着带(主人定的:留到下一次发话才收,看着像没人清理)。
 */
export function withoutEndedAgents(agents: readonly Agent[]): Agent[] {
  return agents.some((agent) => agent.ended)
    ? agents.filter((agent) => !agent.ended)
    : (agents as Agent[]);
}

/** 新的一轮开始:太久没动静的(被杀掉的等不到收场)收起。 */
export function withoutGoneAgents(agents: readonly Agent[], now: number): Agent[] {
  const stay = (agent: Agent) => !now || now - agent.at <= AGENT_STALE;
  return agents.every(stay) ? (agents as Agent[]) : agents.filter(stay);
}

/** 带里从上到下:后派的在上。 */
export function shownAgents(agents: readonly Agent[]): Agent[] {
  return [...agents].reverse();
}

const agentWord = (agent: Agent) =>
  agent.ended === "done" ? "子代理做完了" : agent.ended === "stopped" ? "子代理停了" : "子代理在跑";

export function agentAlt(agent: Agent): string {
  return `${agent.title}:${agentWord(agent)},${agent.steps} 个工具轮`;
}

export function agentLine(agent: Agent): { mark: string; color: string; text: string } {
  return {
    mark: agent.ended === "done" ? "✓" : agent.ended ? "×" : "◆",
    color: agent.ended === "done" ? "green" : agent.ended ? "gray" : "cyan",
    text: `${agent.title}  ${agentWord(agent)}  ${agent.steps} 个工具轮`,
  };
}

const AGENT_LOOKS = {
  running: { from: "#a29bfe", to: "#6c5ce7", ink: "#fff" },
  done: { from: "#a8e6cf", to: "#88d8b0", ink: "#18191C" },
  stopped: { from: "#b2bec3", to: "#636e72", ink: "#fff" },
};

/**
 * 子代理的行:它没有「一共几步」,所以轨道不走格子 —— 在跑的时候整条铺淡底加流动的斜纹,胶囊里是它跑了几趟(发了几次模型请求),
 * 右边是跑了多久。主循环闲着等它的时候,它自己照样动。`now` 与进度行一样是画的这一刻。
 */
export function agentSvg(agent: Agent, options: { now: number }): string {
  const kind = agent.ended ?? "running";
  const look = AGENT_LOOKS[kind];
  const label = `${agent.steps} 个工具轮`;
  const pillW = pillWidth(label);
  const minutes = Math.floor((agent.at - agent.since) / 60_000);
  const title =
    [...agent.title].length > TITLE_CHARS
      ? `${[...agent.title].slice(0, TITLE_CHARS - 1).join("")}…`
      : agent.title;
  const icon =
    kind === "running"
      ? // 三个点,在跑的时候转。试过戴头饰的小女仆,主人说还是换回这个。
        '<g class="pr-icon i-agent" fill="#fff"><circle cy="-4.2" r="2.1"/><circle cx="3.7" cy="2.2" r="2.1"/><circle cx="-3.7" cy="2.2" r="2.1"/></g>'
      : kind === "done"
        ? ICONS.done
        : '<g class="pr-icon" fill="#fff"><rect x="-3.4" y="-3.4" width="6.8" height="6.8" rx="1.4"/></g>';
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ROW_WIDTH} ${ROW_HEIGHT}" width="${ROW_WIDTH}" height="${ROW_HEIGHT}" role="img" font-family="${FONT}">`,
    "<style>",
    ":root{color-scheme:light dark}",
    "text{font-variant-numeric:tabular-nums}",
    "@media (prefers-color-scheme:dark){.pr-ink{fill:#fff}.pr-track{fill:#fff;fill-opacity:.1}}",
    `.pr-row{--at:-${options.now % 3_600_000}ms}`,
    ".i-agent{transform-origin:0 0}",
    "@keyframes pr-spin{to{transform:rotate(360deg)}}",
    "@keyframes pr-stripes{from{transform:translateX(0)}to{transform:translateX(16px)}}",
    ".is-working .i-agent{animation:pr-spin 2.4s linear var(--at) infinite}",
    ".is-working .pr-stripes{animation:pr-stripes .9s linear var(--at) infinite}",
    "@media (prefers-reduced-motion:reduce){.pr-row *{animation:none !important}}",
    "</style>",
    "<defs>",
    `<linearGradient id="pr-ink" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${look.from}"/><stop offset="1" stop-color="${look.to}"/></linearGradient>`,
    '<pattern id="pr-hatch" width="16" height="16" patternUnits="userSpaceOnUse" patternTransform="skewX(-24)"><rect width="8" height="16" fill="#fff" fill-opacity="0.28"/></pattern>',
    `<clipPath id="pr-clip"><rect x="${TRACK_X}" y="${TRACK_Y}" width="${TRACK_W}" height="${TRACK_H}" rx="${TRACK_H / 2}"/></clipPath>`,
    "</defs>",
    `<g class="pr-row k-agent${agent.ended ? "" : " is-working"}">`,
    `<g transform="translate(${DISC} ${ROW_HEIGHT / 2})"><circle r="${DISC}" fill="url(#pr-ink)"/>${icon}</g>`,
    `<text class="pr-ink" x="${TITLE_X}" y="18.5" font-size="13" font-weight="700" fill="#18191C">${escape(title)}</text>`,
    `<rect class="pr-track" x="${TRACK_X}" y="${TRACK_Y}" width="${TRACK_W}" height="${TRACK_H}" rx="${TRACK_H / 2}" fill="#000" fill-opacity="0.06"/>`,
    '<g clip-path="url(#pr-clip)">',
    `<rect x="${TRACK_X}" y="${TRACK_Y}" width="${TRACK_W}" height="${TRACK_H}" fill="url(#pr-ink)" fill-opacity="${agent.ended ? 0.55 : 0.3}"/>`,
    agent.ended
      ? ""
      : `<rect class="pr-stripes" x="${TRACK_X - 16}" y="${TRACK_Y}" width="${TRACK_W + 16}" height="${TRACK_H}" fill="url(#pr-hatch)"/>`,
    `<g transform="translate(${TRACK_X} ${TRACK_Y})"><rect width="${pillW}" height="${TRACK_H}" rx="${TRACK_H / 2}" fill="${look.to}"/>`,
    `<text x="${pillW / 2}" y="13" text-anchor="middle" font-size="11" font-weight="700" fill="${look.ink}">${label}</text></g>`,
    "</g>",
    `<text class="pr-ink" x="${ROW_WIDTH}" y="18.5" text-anchor="end" font-size="13" font-weight="700" fill="#18191C">${minutes < 1 ? "刚开始" : `${minutes} 分`}</text>`,
    "</g></svg>",
  ].join("");
}

/** 伦伦酱读到的回执。 */
export function receiptOf(row: Omit<Row, "was" | "at">): string {
  return `记下了:${row.title},${labelOf(row as Row)},一共 ${row.done}/${totalOf(row.phases)}。`;
}

/** 读屏和终端看到的那句话。 */
export function rowAlt(row: Row): string {
  return `${row.title}:${LOOKS[statusOf(row)].word},${labelOf(row)},${percentOf(row)}%`;
}

/** 终端里的一行。 */
export function rowLine(row: Row): { mark: string; color: string; text: string } {
  const status = statusOf(row);
  const color =
    status === "survey"
      ? "blue"
      : status === "working"
        ? "magenta"
        : status === "decide"
          ? "yellow"
          : "green";
  return {
    mark: status === "done" ? "✓" : status === "decide" ? "?" : "●",
    color,
    text: `${row.title}  ${labelOf(row)}  ${percentOf(row)}%`,
  };
}

/** 胶囊大概多宽:汉字 11、别的 6.5,两边各留 8。SVG 里量不了字宽,只能估。 */
function pillWidth(label: string): number {
  let width = 16;
  for (const char of label) width += char.charCodeAt(0) > 127 ? 11 : 6.5;
  return Math.round(width);
}

const headOf = (done: number, total: number) => Math.round((TRACK_W * done) / total);
/** 写进样式表的数:最多三位小数,零点几不带打头的 0。 */
const short = (value: number) => String(Number(value.toFixed(3))).replace(/^0\./, ".");

/** 条和胶囊滑过去、正在做的那一格跟着淡进来,一共这么久(毫秒)。 */
const SLIDE_MS = 500;

/**
 * `now` 是画的这一刻:循环动画的相位按它算,图被重新摆上去时斜纹和齿轮才接得上。
 * `since` 是画的这一刻离这一行上次变化过去了多久(毫秒)。带里任何一样变了、带子被重画了,宿主都会把
 * 所有图重新摆一遍、动画从头播(真机上用探针量过),所以入场的那一下滑动不能只看「它是不是最新变的」:
 * 还在滑的,把已经过去的那一段记成负的延迟,新摆上去的图接着滑;早就滑完的,直接在位置上,不重播。
 */
export function rowSvg(
  row: Row,
  options: { working: boolean; now: number; since: number },
): string {
  const status = statusOf(row);
  const since = Math.max(0, Math.round(options.since));
  const look = LOOKS[status];
  const total = totalOf(row.phases);
  const pill = pillOf(row);
  const pillW = pillWidth(pill);
  const underWay = status === "survey" || status === "working";
  const head = headOf(row.done, total);
  const from = headOf(Math.min(row.was, total), total);
  const pillAt = (x: number) => Math.min(Math.max(0, x - pillW), TRACK_W - pillW);
  const moved = since < SLIDE_MS && from !== head;
  const title =
    [...row.title].length > TITLE_CHARS
      ? `${[...row.title].slice(0, TITLE_CHARS - 1).join("")}…`
      : row.title;

  // 每一步一道小刻度,阶段之间一道通高的线。
  const ticks: string[] = [];
  let edge = 0;
  const edges = new Set(row.phases.map((phase) => (edge += phase.steps)));
  const hasSmallTicks = TRACK_W / total >= TICK_ROOM;
  for (let i = 1; i < total; i++) {
    if (!edges.has(i) && !hasSmallTicks) continue;
    const x = TRACK_X + headOf(i, total) - 1;
    ticks.push(
      edges.has(i)
        ? `<rect class="pr-edge" x="${x}" y="${TRACK_Y}" width="2" height="${TRACK_H}" fill="#000" fill-opacity="0.16"/>`
        : `<rect class="pr-tick" x="${x}" y="${TRACK_Y + 6}" width="2" height="6" rx="1" fill="#000" fill-opacity="0.18"/>`,
    );
  }

  // 正在做的这一步:从进度头到下一道刻度,铺一层淡的同色底。等拍板和做完了没有「正在做」。
  // 它从胶囊的右端往里半个圆角起(胶囊盖在上面,圆角外面就不露缺口),到下一道刻度止;
  // 胶囊被顶在轨道最左时,右端比进度头靠右,从胶囊算。这一步比胶囊还窄的话没地方画。
  const next = headOf(Math.min(row.done + 1, total), total);
  const pillEnd = pillAt(head) + pillW;
  const start = pillEnd - TRACK_H / 2;
  // 底上是几只小箭头,从胶囊走向下一道刻度:胶囊写的是正在做的阶段,人却趴在做完的那一段上,
  // 箭头说的是「从这儿干到那儿」(主人定的;把胶囊挪进这一格的话,上色的长度就不等于做完的了)。
  // 回合停了它们不走,叠成胶囊右边的一只。胶囊右边剩得太少、一只都放不下时,照旧铺流动的斜纹。
  // 它们从胶囊底下钻出来,一直走到下一道刻度:整格都是路,几只把一趟平分着错开,前后正好隔一格宽除以只数
  // (只让它们在格子中间走的话,窄格子里两只都嫌挤,主人看过)。
  const room = next - pillEnd;
  const arrows = Math.min(Math.round(room / WALK_GAP), Math.floor(room / WALK_TIGHT));
  const walks = arrows > 0;
  const arrowX = TRACK_X + pillEnd + 5;
  const arrowY = TRACK_Y + TRACK_H / 2 - 4;
  const doing =
    underWay && next > start
      ? `<g class="pr-doing" clip-path="url(#pr-next)"><rect x="${TRACK_X + start}" y="${TRACK_Y}" width="${next - start}" height="${TRACK_H}" fill="url(#pr-ink)" fill-opacity="0.3"/>` +
        (walks
          ? `<g fill="none" stroke="${look.pill}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${Array.from(
              { length: arrows },
              (_, k) =>
                `<path class="pr-walk${k ? ` d${k}` : ""}" d="M${arrowX},${arrowY} l4,4 l-4,4"/>`,
            ).join("")}</g>`
          : `<rect class="pr-stripes" x="${TRACK_X + start - 16}" y="${TRACK_Y}" width="${next - start + 16}" height="${TRACK_H}" fill="url(#pr-hatch)"/>`) +
        "</g>"
      : "";
  // 速度和密度不随格子变:路长一趟就久、排的只数就多,两头淡入淡出的长度也不跟着变长。
  const lap = room / WALK_SPEED;
  const fade = Math.min(20, (WALK_FADE / room) * 100);
  const walk = walks
    ? `@keyframes pr-walk{0%{transform:translateX(${-WALK_IN}px);opacity:0}${short(fade)}%{opacity:1}${short(100 - fade)}%{opacity:1}100%{transform:translateX(${room - WALK_IN}px);opacity:0}}` +
      `.is-working .pr-walk{animation:pr-walk ${short(lap)}s linear var(--at) infinite}` +
      Array.from(
        { length: arrows - 1 },
        (_, k) =>
          `.is-working .pr-walk.d${k + 1}{animation-delay:calc(var(--at) + ${short(((k + 1) * lap) / arrows)}s)}`,
      ).join("")
    : "";

  const motion = moved
    ? `.pr-row{--since:${-since}ms}` +
      `@keyframes pr-fill{from{transform:translateX(${from - TRACK_W}px)}to{transform:translateX(${head - TRACK_W}px)}}` +
      `@keyframes pr-pill{from{transform:translateX(${pillAt(from)}px)}to{transform:translateX(${pillAt(head)}px)}}` +
      `.pr-fill{animation:pr-fill .45s ${EASE_IN_OUT} var(--since) both}.pr-pill{animation:pr-pill .45s ${EASE_IN_OUT} var(--since) both}` +
      // 正在做的那一格等胶囊快滑到了再淡进来:立刻出现的话,它悬在前面,和还在路上的胶囊之间隔着一段空轨道。
      "@keyframes pr-doing{from{opacity:0}to{opacity:1}}.pr-doing{animation:pr-doing .2s ease-out calc(var(--since) + .3s) both}"
    : "";

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ROW_WIDTH} ${ROW_HEIGHT}" width="${ROW_WIDTH}" height="${ROW_HEIGHT}" role="img" font-family="${FONT}">`,
    "<style>",
    ":root{color-scheme:light dark}",
    "text{font-variant-numeric:tabular-nums}",
    "@media (prefers-color-scheme:dark){.pr-ink{fill:#fff}.pr-track{fill:#fff;fill-opacity:.1}.pr-tick,.pr-edge{fill:#fff;fill-opacity:.3}}",
    `.pr-row{--at:-${options.now % 3_600_000}ms}`,
    `.pr-fill{transform:translateX(${head - TRACK_W}px)}`,
    `.pr-pill{transform:translateX(${pillAt(head)}px)}`,
    motion,
    ".i-survey,.i-working,.pr-ring{transform-origin:0 0}",
    "@keyframes pr-scan{from{transform:rotate(-16deg)}to{transform:rotate(12deg)}}",
    "@keyframes pr-spin{to{transform:rotate(360deg)}}",
    "@keyframes pr-ring{0%,52%,100%{transform:rotate(0)}60%{transform:rotate(-12deg)}68%{transform:rotate(10deg)}76%{transform:rotate(-7deg)}84%{transform:rotate(4deg)}}",
    "@keyframes pr-ringmark{0%,50%,100%{opacity:.35}60%,84%{opacity:1}}",
    "@keyframes pr-stripes{from{transform:translateX(0)}to{transform:translateX(16px)}}",
    ".is-working .i-survey{animation:pr-scan 1.1s ease-in-out var(--at) infinite alternate}",
    ".is-working .i-working{animation:pr-spin 3.2s linear var(--at) infinite}",
    // 铃和它的弧线不挂在 is-working 底下:等你拍板的时候回合多半已经停了。
    ".pr-ring{animation:pr-ring 2.2s ease-in-out var(--at) infinite}",
    ".pr-ringmark{animation:pr-ringmark 2.2s ease-in-out var(--at) infinite}",
    ".is-working .pr-stripes{animation:pr-stripes .9s linear var(--at) infinite}",
    walk,
    // 正在做的那个阶段的字一明一暗:还没做完。只动透明度,幅度小、周期长,不是闪。
    "@keyframes pr-now{from{fill-opacity:1}to{fill-opacity:.45}}",
    ".is-working .pr-now{animation:pr-now 1.4s ease-in-out var(--at) infinite alternate}",
    ".k-decide .pr-stripes,.k-done .pr-stripes{display:none}",
    "@media (prefers-reduced-motion:reduce){.pr-row *{animation:none !important}}",
    "</style>",
    "<defs>",
    `<linearGradient id="pr-disc" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${look.from}"/><stop offset="1" stop-color="${look.to}"/></linearGradient>`,
    `<linearGradient id="pr-ink" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${look.from}"/><stop offset="1" stop-color="${look.to}"/></linearGradient>`,
    '<pattern id="pr-hatch" width="16" height="16" patternUnits="userSpaceOnUse" patternTransform="skewX(-24)"><rect width="8" height="16" fill="#fff" fill-opacity="0.28"/></pattern>',
    // 斜纹流动时会比它盖的东西多出一截,各自关在裁切框里:填充上的不出填充,正在做的那一格的不出那一格。
    `<clipPath id="pr-done"><rect width="${TRACK_W}" height="${TRACK_H}"/></clipPath>`,
    `<clipPath id="pr-next"><rect x="${TRACK_X + start}" y="${TRACK_Y}" width="${Math.max(0, next - start)}" height="${TRACK_H}"/></clipPath>`,
    `<clipPath id="pr-clip"><rect x="${TRACK_X}" y="${TRACK_Y}" width="${TRACK_W}" height="${TRACK_H}" rx="${TRACK_H / 2}"/></clipPath>`,
    "</defs>",
    `<g class="pr-row k-${status}${options.working ? " is-working" : ""}">`,
    `<g transform="translate(${DISC} ${ROW_HEIGHT / 2})"><circle r="${DISC}" fill="${look.disc}"/>${ICONS[status]}</g>`,
    `<text class="pr-ink" x="${TITLE_X}" y="18.5" font-size="13" font-weight="700" fill="#18191C">${escape(title)}</text>`,
    `<rect class="pr-track" x="${TRACK_X}" y="${TRACK_Y}" width="${TRACK_W}" height="${TRACK_H}" rx="${TRACK_H / 2}" fill="#000" fill-opacity="0.06"/>`,
    '<g clip-path="url(#pr-clip)">',
    `<g transform="translate(${TRACK_X} ${TRACK_Y})"><g class="pr-fill"><rect width="${TRACK_W}" height="${TRACK_H}" rx="${TRACK_H / 2}" fill="url(#pr-ink)"/>`,
    `<g clip-path="url(#pr-done)"><rect class="pr-stripes" x="-16" width="${TRACK_W + 16}" height="${TRACK_H}" fill="url(#pr-hatch)"/></g></g></g>`,
    doing,
    ticks.join(""),
    `<g transform="translate(${TRACK_X} ${TRACK_Y})"><g class="pr-pill"><rect width="${pillW}" height="${TRACK_H}" rx="${TRACK_H / 2}" fill="${look.pill}"/>`,
    `<text x="${pillW / 2}" y="13" text-anchor="middle" font-size="11" font-weight="700" fill="${look.ink}">${underWay ? `<tspan class="pr-now">${escape(pill)}</tspan>` : escape(pill)}</text></g></g>`,
    "</g>",
    `<text class="pr-ink" x="${ROW_WIDTH}" y="18.5" text-anchor="end" font-size="13" font-weight="700" fill="#18191C">${countOf(row)}</text>`,
    "</g></svg>",
  ].join("");
}

/** 报上来的字要进 SVG 的标记里,先把会被当成标记的那几个字符换掉。 */
function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
