// context-band:输入框上方的那一条 —— 上下文窗口的「天气」、账号的 5 小时与本周两个窗口,
// 上面是模型报上来的进度行和派出去的子代理。
//
// 窗口那一格是跟着回合走的:
// turn.start:一轮开始,卡片上此刻的读数就是起点 —— 这一轮涨了多少从它起算。
// session.compact:压缩过,窗口落下去了,读数和起点跟着落。
// turn.step:这一轮里每发完一次模型请求读一次,卡片在干活的时候就跟着动,不等答完。
//   用的是接口给这次请求报的账(进去的加出来的),回应流的过程中不动。
// turn.complete:主循环答完一轮,这一轮涨了多少记成一根柱子,留最近 HISTORY 根。
// session.start:还没有读数时先读一次,不等第一轮开始仪表就在。
// session.measure:额度窗口挪了一个整点,宿主会推过来,两格额度跟着动。
// tool.call (progress):伦伦酱报一件活做到哪了,记成仪表下面的一行。
// prompt.context:把「怎么报进度」的说明带进对话,装了这个 mod 就不用再往 CLAUDE.md 里添一句。
// ui.render (AbovePrompt):桌面应用仪表一张 Svg、每行进度一张 Svg,终端各画一行字,别的界面不画。
//
// 读数放在 $.state:热加载会清掉模块变量,$.state 是宿主替这个会话存着的,
// 而且写进去会自动重画读它的地方,不用再喊 $.ui.invalidate。
// 每写一次,宿主就把整张图换一次。所以卡片画的东西全放在一个值里,一次事件只写一回;
// 什么都没变就不写 —— 真机上撞过:分三处写、次次都写,每读一次数卡片要闪好几下。
//
// 进度行另外落一份盘($.store):$.state 只活在这个进程里,应用一重启就没了
// (真机上撞过:隔了一夜回来续上同一个会话,行全丢了,要重报才回来)。
// 盘上按会话各记各的;卡片的每一次写都从 change 过 —— 写之前把盘上的行接回来,写之后行变了就落盘。

import { atom, read, update } from "claude-code";
import type { EngineInterface, Register } from "claude-code";

import type { Card, Limits, Reading, Row, Turn } from "../types";
import { CARD_HEIGHT, cardAlt, cardSvg } from "./card";
import {
  ROW_HEIGHT,
  agentAlt,
  agentLine,
  agentSvg,
  isForgotten,
  keptOf,
  receiptOf,
  rowAlt,
  rowLine,
  rowOf,
  rowSvg,
  rowsFrom,
  shownAgents,
  shownRows,
  statusOf,
  withAgentEnd,
  withAgentStep,
  withoutEndedAgents,
  withReport,
  withSpawn,
  withoutDecide,
  withoutGoneAgents,
  withoutStale,
} from "./progress";
import {
  barHeights,
  levelFor,
  limitsOf,
  passesOf,
  readingOf,
  readsTheSame,
  short,
  spentText,
  withTurn,
} from "./forecast";

const BARS = "▁▂▃▄▅▆▇█";

const card = atom(
  { plugin: "context-band", key: "card" } as const,
  { gauge: null, turns: [], limits: {}, running: false } as Card,
);

/**
 * 读到的一次用量:窗口此刻的读数(用了多少还不知道时没有)、窗口多大、这一次带来的额度窗口(一个都没带就没有)、
 * 读的时刻。没读到(宿主出了岔子)就什么都没有,时刻是 0。
 */
type Measure = { now?: Reading; window?: number; limits?: Limits; at: number };

/** 这一轮最后一次请求收完时窗口的读数,留给回合结束用。模块变量:热加载丢了就现读。 */
let landing: { turnId: string; now?: Reading } | undefined;

/**
 * 用接口给这次请求报的账把读数校准:输入的三样加起来是请求发出去时窗口里有多少,再加上这次回应的输出,
 * 才是回应之后窗口里有多少。宿主报的用量只有前一半。没有账就用宿主报的。
 * 账是这次请求在服务端每一遍加起来的:跑了几遍,输入那一半就除以几(真机上撞过:跑了两遍,窗口被画成 117%)。
 * 输出不除:前一遍写的字已经在后一遍的输入里,多算的只是那一小段。
 */
function withBill(
  measured: Measure,
  bill: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  } | null,
): Measure {
  if (!measured.window || !bill) return measured;
  const sent = bill.input_tokens + bill.cache_read_input_tokens + bill.cache_creation_input_tokens;
  const tokens = Math.round(sent / passesOf(sent, measured.now?.tokens)) + bill.output_tokens;
  return { ...measured, now: readingOf({ tokens, window: measured.window }) };
}

/**
 * 这一次读到的额度并进卡片:带了哪个窗口就换哪个,没带的留着原来的(一次读数里缺一个窗口,那一格不该闪没);
 * 一个都没带就什么都不动。「还剩多久」从这一次读的时刻算。
 */
function quotas(shown: Card, measured: Measure): Pick<Card, "limits" | "limitsAt"> {
  if (!measured.limits || Object.keys(measured.limits).length === 0 || !measured.at)
    return { limits: shown.limits, limitsAt: shown.limitsAt };
  return { limits: { ...shown.limits, ...measured.limits }, limitsAt: measured.at };
}

/** 「报进度」这个工具:模型看到的名字是 mcp__context-band__progress。 */
const PROGRESS = {
  name: "progress",
  description:
    "把一件多步的活做到哪了报给用户看:输入框上方会多出一行进度条。开工时报一次(把阶段和每阶段几步列出来)," +
    "每做完一步、换阶段、停下来等用户拍板(status 传 decide,每次都要传)、整件做完时各报一次。" +
    "done 是一共做完了几步;同一件活每次用同一个 plan。" +
    "先报的行在下、后报的在上:一件大工程先报总进度,再报当前这一段,最后报手上这一件,最下面就是总进度、越往上越细。" +
    "用户回了话之后,等拍板的行会自己回到工作中。派出去的子代理自己会有一行,不用替它报。",
  inputSchema: {
    type: "object",
    properties: {
      plan: { type: "string", description: "这件活的标识,同一件活每次都用同一个" },
      title: { type: "string", description: "行上显示的标题,十个字以内" },
      phases: {
        type: "array",
        description: "按顺序的各个阶段",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "阶段名,两三个字" },
            steps: { type: "integer", minimum: 1, description: "这个阶段有几步" },
            survey: { type: "boolean", description: "只看不改的勘察类阶段传 true" },
          },
          required: ["name", "steps"],
        },
      },
      done: { type: "integer", minimum: 0, description: "一共做完了几步(跨阶段累计)" },
      status: {
        type: "string",
        enum: ["survey", "working", "decide", "done"],
        description: "一般不用传,由步数推;停下来等用户拍板时传 decide",
      },
      remove: { type: "boolean", description: "传 true 把这一行撤掉" },
    },
    required: ["plan", "title", "phases", "done"],
  },
};

/**
 * 「怎么报进度」的说明,随 mod 进对话:和 CLAUDE.md 的内容一样,挂在对话第一条消息带的上下文里,一场对话带一次。
 * 没有它的话,装了 mod 的人还得自己去 CLAUDE.md 里写一段,模型才知道有这个工具、什么时候该报(主人指出来的)。
 * 工具在不少环境里是「要用再取」的,模型看不到它的说明,所以这里得把名字和取法写全。
 * 大工程怎么报也写在这儿:原先那一套住在主人的全局 CLAUDE.md 里,主人要的是开箱即用,自己也不用添一个字。
 */
const USAGE = {
  name: "contextBand",
  text: [
    "输入框上方有一条进度带,由 context-band 这个 mod 画。做**多步的活**(预计不止一两轮工具调用)时用 `mcp__context-band__progress` 报进度;一两步的小活不用报。工具没加载时先用 `ToolSearch` 取它,取不到就跳过,不要为此停下。",
    "",
    "- **什么时候报**:开工时报一次(列出阶段和每阶段几步);每做完一步、换阶段、整件做完各报一次。`done` 是一共做完了几步;同一件活每次用同一个 `plan`。",
    "- **大工程报三条,先大后细**:先报的行在下、后报的在上,所以按「总、段、件」的顺序报,最下面是总进度,越往上越细。「整个工程」每个大阶段列成一个阶段、各一步;「当前这个大阶段」只列一个阶段,里面每件活一步;「手上这一件」每个小件一个阶段,小件里再分步。只为算进度而存在的准备、勘察、开工不单列阶段。做完一个小件更新第三条;做完一整件更新第二条并换第三条;走完一个大阶段更新第一条。只做一件不属于大工程的小活时,报一条就够。",
    "- **行上的字由 mod 算**:胶囊写的是正在做的那个阶段的名字。行尾的数字数的是做完的(刚开工是 0):只有一个阶段的显示「做完几步 / 共几步」;有好几个阶段的显示「做完几个阶段 / 共几个阶段」,眼下这个阶段自己还分步时,阶段数后面多一个小数点和它做完的步数(「1.2/3」),只有一步的阶段不带小数。上面三条依次是「1/7」「9/18」「1.2/3」这三种。",
    '- **等用户拍板**:停下来问用户时传 `status: "decide"`,每次都要传。用户回话后那一行会自己回到工作中,不用专门撤。',
    // 这段说明子代理的对话里也会带上,工具它也取得到(真机上派探针看过),所以得有一句是直接说给它听的。
    "- **你自己就是被派出去的子代理时不要报**:带上已经有你的一行了。派子代理的一方也不用替它报;那一行的标题是派它时写的 description,所以 description 要写得让人看得懂是哪件活。",
    "- **撤行**:计划改了、这件活不做了,传 `remove: true` 撤掉。",
  ].join("\n"),
};

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    const result = await next(e);
    // 热加载也会再发一次 session.start:读数照读,但这一轮从哪起算留着不动 —— 热加载可能正落在一轮中间。
    const shown = await draw($, await measure($), (shown, measured) => {
      const { now, at } = measured;
      return {
        ...shown,
        ...quotas(shown, measured),
        gauge: now ? { now, was: now, base: shown.gauge?.base ?? now.tokens, at } : shown.gauge,
      };
    });
    // 状态里的行补落一次盘:盘上那份可能落后 —— 落盘这件事上线之前报的行只在状态里,上一次也可能没写成。
    // 行还没接回来(盘读不了)时不落:拿空的会把盘上的删掉。
    if (shown.rows) await keep($, shown.rows);
    // 「报进度」的工具放在最后注册:它注册不上(宿主不给)也不耽误仪表。同名再注册是覆盖,热加载无妨。
    try {
      await $.tool.register(PROGRESS);
    } catch {
      // 没有这个工具,进度行就一直是空的。
    }
    return result;
  });

  on("tool.call", { tool: "mcp__context-band__progress" }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>;
    // 撤一行只认 plan:别的字段不用带,带了也不看。没有这一行就照实说,不说「撤掉了」。
    if (input.remove === true) {
      let answer = "";
      await change($, (shown) => {
        const rows = shown.rows ?? [];
        const found = rows.find((row) => row.plan === input.plan);
        answer = `${found ? `撤掉了:${found.title}` : `没有这一行:${String(input.plan)}`}。带里现在 ${rows.length - (found ? 1 : 0)} 行。`;
        return found ? { ...shown, rows: rows.filter((row) => row !== found) } : shown;
      });
      return { result: answer };
    }
    const report = rowOf(input);
    if (typeof report === "string") return { result: `没记上:${report}。` };
    // 要等的(看钟)先等完,再在当前的值上改:两件活可以同时报,回合里别处也在写,
    // 拿等之前读到的那份整个写回去会把别人刚写的盖掉(真机上撞过:行闪了几下就没了)。
    const at = await $.clock.now();
    let count = 0;
    await change($, (shown) => {
      const rows = shown.rows ?? [];
      const next = withReport(rows, report, at);
      count = next.length;
      return next === rows ? shown : { ...shown, rows: next };
    });
    return { result: `${receiptOf(report)}带里现在 ${count} 行。` };
  });

  on("prompt.context", async ($, e, next) => {
    // 接在引擎自己那几块后面;已经有一块同名的(别处带进来的旧说明)就换掉,不带两份。
    const result = await next(e);
    return {
      ...result,
      blocks: [...result.blocks.filter((block) => block.name !== USAGE.name), USAGE],
    };
  });

  on("prompt.submit", async ($, e, next) => {
    // 主人发话了:等拍板的行不用再等。只认主人发的这一下 —— 后台的活回来也会开一轮,那不算回话。
    await change($, (shown) => {
      const rows = withoutDecide(shown.rows ?? []);
      return rows === (shown.rows ?? rows) ? shown : { ...shown, rows };
    });
    return next(e);
  });

  on("agent.spawn", async ($, e, next) => {
    const result = await next(e);
    const id = result.agentId;
    if (id) {
      const at = await $.clock.now();
      await change($, (shown) => ({
        ...shown,
        agents: withSpawn(shown.agents ?? [], id, e.description, at),
      }));
    }
    return result;
  });

  on("session.measure", async ($, e, next) => {
    const result = await next(e);
    // 只挪了窗口用量的那种不看:那一次带来的额度可能是空的,照抄会把两格抹掉。
    if (e.changed.includes("rateLimits")) {
      const measured = { limits: limitsOf(e.rateLimits), at: await $.clock.now() };
      await draw($, measured, (shown) => ({ ...shown, ...quotas(shown, measured) }));
    }
    return result;
  });

  on("session.end", async ($, e, next) => {
    // 会话在一轮中间结束(退出、续接到别处):那一轮等不到 turn.complete 了,把「在跑」撤掉,
    // 不然这份状态被接着用时卡片一直是干活的样子。
    await change($, (shown) => (shown.running ? { ...shown, running: false } : shown));
    return next(e);
  });

  on("session.compact", async ($, e, next) => {
    const result = await next(e);
    // 真压了(不是被跳过)、压的是主循环:窗口落下去了,读数和起点跟着落。
    // 压完还剩多少,宿主在结果里说了就用它 —— 现读的用量算到的是「上一次请求发出去时」,刚压完可能还是压之前的数。
    // 压之前留着的「最后一次请求的读数」也作废。
    if (!e.agentId && result.messages) {
      landing = undefined;
      const after = result.tokensAfter;
      await draw($, await measure($), (shown, measured) => {
        const window = measured.window ?? shown.gauge?.now.window;
        const now =
          after !== undefined && window ? readingOf({ tokens: after, window }) : measured.now;
        return {
          ...shown,
          ...quotas(shown, measured),
          gauge: now
            ? { now, was: now, base: now.tokens, at: measured.at || (shown.gauge?.at ?? 0) }
            : shown.gauge,
        };
      });
    }
    return result;
  });

  on("turn.start", async ($, e, next) => {
    const result = await next(e);
    // 起点是卡片上已有的读数,不现读:宿主报的用量只算到上一次请求发出去时,不含那次回应,
    // 拿它当起点会把上一轮的回应算进这一轮(真机上撞过)。两轮之间压缩过的话,session.compact 那边已经把读数落下去了。
    // 「上一次画的」也拨到此刻,上一轮带进来的入场动画就不会跟着这次重画再播一遍。
    await draw($, await measure($), (shown, measured) => {
      const { now, at } = measured;
      const from = shown.gauge?.now ?? now;
      // 做完的行看过一轮了,新的一轮开始就收起;整条带太久没人报的话也全收起(多半是不做了)。
      // 留下的行「上一次画的」拨到此刻,不跟着这次重画再滑一遍。
      const open = (shown.rows ?? []).filter((row) => statusOf(row) !== "done");
      return {
        ...shown,
        ...quotas(shown, measured),
        rows: settled(at ? withoutStale(open, at) : open),
        // 太久没动静的子代理收起;跑完的在主循环答完那一下收(turn.complete)。
        agents: withoutGoneAgents(shown.agents ?? [], at),
        running: true,
        gauge: from
          ? { now: from, was: from, base: from.tokens, at: at || (shown.gauge?.at ?? 0) }
          : shown.gauge,
      };
    });
    return result;
  });

  on("turn.step", async function* ($, e, next) {
    // 回应流的过程中卡片不动:边流边估试过,一个回应里数字要变好几回,乱跳(主人定的)。
    // 只在请求收完时落一次接口报的准数。
    const result = yield* next(e);
    // 子代理的请求不算进仪表:它们跑在自己的窗口里。只在它自己那一行上记一次。
    const agentId = e.agentId;
    if (agentId) {
      const at = await $.clock.now();
      await change($, (shown) => ({
        ...shown,
        agents: withAgentStep(shown.agents ?? [], agentId, e.turnId, at),
      }));
      return result;
    }
    // 以压缩收场的请求不是读数:它的账是压之前的大小,窗口随后就落下去了,落到多少由 session.compact 那边管。
    if (result.stopReason === "compaction") return result;
    const measured = withBill(await measure($), result.usage);
    if (result.stopReason !== "tool_use" && result.stopReason !== "pause_turn") {
      landing = { turnId: e.turnId, now: measured.now };
    } else {
      await draw($, measured, (shown) => {
        const { now, at } = measured;
        const gauge = shown.gauge;
        // 写出来和卡片上现有的一模一样就什么都不碰,连读数的时刻也不碰:图一个字不变,宿主没有东西可换。
        if (!now || (gauge && readsTheSame(gauge.now, now, gauge.base)))
          return { ...shown, ...quotas(shown, measured) };
        return {
          ...shown,
          ...quotas(shown, measured),
          gauge: { now, was: gauge?.now ?? now, base: gauge?.base ?? now.tokens, at },
        };
      });
    }
    return result;
  });

  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    const agentId = e.agentId;
    if (agentId) {
      const at = await $.clock.now();
      const ended = e.isAborted || e.reason === "error" ? "stopped" : "done";
      await change($, (shown) => {
        const agents = shown.agents ?? [];
        return agents.some((agent) => agent.id === agentId)
          ? { ...shown, agents: withAgentEnd(agents, agentId, ended, e.turnId, at) }
          : shown;
      });
    } else {
      // 最后一次请求留下的读数最准(它算上了那次回应);没有的话(这一轮没发过请求,或者中途热加载过)现读。
      const last = landing?.turnId === e.turnId ? landing : undefined;
      const landed = last?.now;
      landing = undefined;
      // 没读到数也要把「在跑」撤掉(被打断的那一轮常常这样),不然卡片一直是干活的样子。
      const taken = await measure($);
      const measured = landed ? { ...taken, now: landed } : taken;
      await draw($, measured, (shown) => {
        const { now, at } = measured;
        const rows = settled(shown.rows ?? []);
        const agents = withoutEndedAgents(shown.agents ?? []);
        // 没有读数:一种是没读到,一种是卡片上本来就没有、宿主也还说不出窗口用了多少。都只收尾,不记柱子。
        if (!now) return { ...shown, ...quotas(shown, measured), rows, agents, running: false };
        const spent = now.tokens - (shown.gauge?.base ?? now.tokens);
        return {
          ...shown,
          ...quotas(shown, measured),
          rows,
          agents,
          running: false,
          turns: withTurn(shown.turns, { spent, percent: now.percent }),
          gauge: {
            now,
            was: shown.gauge?.now ?? now,
            base: now.tokens,
            at: at || (shown.gauge?.at ?? 0),
          },
        };
      });
    }
    return result;
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const {
      gauge: shown,
      turns: history,
      limits: quota,
      limitsAt,
      running,
      rows: all,
      agents: sent,
    } = await read($, card);
    const rows = shownRows(all ?? []);
    const agents = shownAgents(sent ?? []);
    if (e.props.hasSurvey || (!shown && rows.length === 0 && agents.length === 0)) {
      return next(e);
    }
    if (e.surface === "desktop") {
      const { Box, Svg } = $.ui.resolve(e);
      // 子代理的行在最上、进度行其次、仪表在最下面:行多了往上长,仪表的位置不动。每样各一张图。
      // 带里任何一样变了,宿主会把这些图都重新摆一遍、动画从头播,所以相位都按最新的那个时刻算;
      // 入场动画只给「最新的那次变化」本身,别的图只是被重新摆上去,不重播。
      const latest = Math.max(
        shown?.at ?? 0,
        ...rows.map((row) => row.at),
        ...agents.map((agent) => agent.at),
      );
      // 当图片画,不画在沙箱框里(isInteractive):框每换一次内容要整个重载,重载那一瞬是空的,
      // 实时更新之后卡片每读一次数就闪一下。真机上用探针并排比过:图片换内容不闪。
      // 图的大小宿主不会从 SVG 里读(真机量过三回):
      // 高度必须给,不给就是 150 高。
      // 宽度不给,并且外面套一层竖排的 Box:Box 把框拉到和这一条一样宽,这一行在里面居中。
      // 给固定宽度的话它贴在左边、右边空一截;不套 Box 的话框是默认的 300 宽、内容缩成四成。
      // 那一条比这一行窄时,宿主把内容等比缩小,不会裁掉。
      return (
        <Box flexDirection="column">
          {agents.map((agent) => (
            <Svg
              source={agentSvg(agent, { now: latest })}
              alt={agentAlt(agent)}
              height={ROW_HEIGHT}
            />
          ))}
          {rows.map((row) => (
            <Svg
              source={rowSvg(row, { working: running, now: latest, fresh: row.at >= latest })}
              alt={rowAlt(row)}
              height={ROW_HEIGHT}
            />
          ))}
          {shown ? (
            <Svg
              source={cardSvg(shown, history, {
                working: running,
                limits: quota,
                limitsAt,
                now: latest,
                fresh: shown.at >= latest,
              })}
              alt={cardAlt(shown, history, quota)}
              height={CARD_HEIGHT}
            />
          ) : null}
        </Box>
      );
    }
    if (e.surface !== "terminal") {
      return next(e);
    }

    const { Box, Text } = $.ui.resolve(e);
    const level = shown ? levelFor(shown.now.percent) : undefined;
    const last = history[history.length - 1];
    const isWide = e.props.bodyColumns >= 60;

    return (
      <Box flexDirection="column" paddingX={1}>
        {agents.map((agent) => {
          const line = agentLine(agent);
          return (
            <Box flexDirection="row">
              <Text color={line.color} bold>
                {line.mark}
              </Text>
              <Text>{`  ${line.text}`}</Text>
            </Box>
          );
        })}
        {rows.map((row) => {
          const line = rowLine(row);
          return (
            <Box flexDirection="row">
              <Text color={line.color} bold>
                {line.mark}
              </Text>
              <Text>{`  ${line.text}`}</Text>
            </Box>
          );
        })}
        {shown && level ? (
          <Box flexDirection="row">
            <Text color={level.color} bold>
              {level.glyph} {level.word}
            </Text>
            <Text>{`  上下文 ${shown.now.percent}%`}</Text>
            <Text dimColor>{`  ${short(shown.now.tokens)} / ${short(shown.now.window)}`}</Text>
            {isWide && last ? <Text dimColor>{"   最近几轮 "}</Text> : null}
            {isWide && last ? <Text color={level.color}>{chart(history)}</Text> : null}
            {isWide && last ? <Text dimColor>{`  ${spentText(last.spent)}`}</Text> : null}
          </Box>
        ) : null}
      </Box>
    );
  });
};

/** 行上「上一次画的步数」拨到此刻。什么都不用拨时原样交回,免得白写一次状态。 */
function settled(rows: readonly Row[]): Row[] {
  return rows.every((row) => row.was === row.done)
    ? (rows as Row[])
    : rows.map((row) => ({ ...row, was: row.done }));
}

/** 读一次用量。没读到(宿主出了岔子)就是一份空的,仪表留着上一次的。 */
async function measure($: EngineInterface): Promise<Measure> {
  try {
    const { context, rateLimits } = await $.session.usage();
    return {
      now: readingOf(context),
      window: context?.window,
      limits: limitsOf(rateLimits ?? []),
      at: await $.clock.now(),
    };
  } catch {
    return { at: 0 };
  }
}

/** 把读到的用量画上去:在当前的值上算出卡片接下来的样子,和现在的不一样才换。交回画完的那一张。 */
function draw<M extends Measure>(
  $: EngineInterface,
  measured: M,
  next: (shown: Card, measured: M) => Card,
): Promise<Card> {
  // 在当前的值上改,不拿先读出来的那份写回去:读和写之间别处可能已经写过了。
  return change($, (shown) => {
    const drawn = next(shown, measured);
    return JSON.stringify(drawn) === JSON.stringify(shown) ? shown : drawn;
  });
}

/** 盘上记一个会话的行用的键。行跟着会话走:主人同时开着几个会话,各记各的,谁也不盖谁。 */
const ROWS = "rows:";
const keyOf = (session: string) => `${ROWS}${session}`;

/** 行里要落盘的那些,写成一串字:比「行变了没有」用。 */
const kept = (rows: readonly Row[] | undefined) => JSON.stringify(keptOf(rows ?? []));

/**
 * 卡片的每一次写都从这儿过。
 * 写之前:状态里还没有行(进程刚起来),先把盘上的接回来 —— 接回来之前谁都不写,不然拿空的把盘上的盖掉。
 * 写之后:行变了就落盘。每次变都落,不等会话结束:应用被关掉时会话结束那一下不一定走得到。
 */
async function change($: EngineInterface, next: (shown: Card) => Card): Promise<Card> {
  await restore($);
  let moved = false;
  const written = await update($, card, (shown) => {
    const drawn = next(shown);
    moved = kept(drawn.rows) !== kept(shown.rows);
    return drawn;
  });
  if (moved) await keep($, written.rows ?? []);
  return written;
}

/**
 * 进程刚起来(应用重启后续上会话):状态里还没有行,把盘上这个会话的行接回来。
 * 只看状态里有没有行,不在模块里记「接过了」:热加载会清模块变量,而那时状态里的行还在,不该再读盘。
 * 接回来之后顺手把别的会话留在盘上、没人管了的行清掉:进程起来时清一回就够。
 */
async function restore($: EngineInterface): Promise<void> {
  if ((await read($, card)).rows !== undefined) return;
  try {
    const mine = keyOf(await $.session.id());
    const rows = rowsFrom(await $.store.get(mine));
    await update($, card, (shown) => (shown.rows === undefined ? { ...shown, rows } : shown));
    const now = await $.clock.now();
    for (const key of await $.store.keys()) {
      if (
        key !== mine &&
        key.startsWith(ROWS) &&
        isForgotten(rowsFrom(await $.store.get(key)), now)
      )
        await $.store.delete(key);
    }
  } catch {
    // 盘读不了:行先空着,下一次写之前再试;清到一半断了的,下回进程起来接着清。
  }
}

/** 落盘排着队来:两件活同时报,后落进状态的那一份也后落盘,盘上留下的一定是最新的。 */
let saving: Promise<void> = Promise.resolve();

/**
 * 行落盘;一行都不剩就把这个会话那份删掉。
 * 写不了(盘满了、宿主出了岔子)就算了:行还在状态里,只是重启后接不回来,不能让报进度因此坏掉。
 */
function keep($: EngineInterface, rows: readonly Row[]): Promise<void> {
  saving = saving.then(async () => {
    try {
      const key = keyOf(await $.session.id());
      if (rows.length === 0) await $.store.delete(key);
      else await $.store.set(key, keptOf(rows));
    } catch {
      // 盘上那份停在上一次写成的样子。
    }
  });
  return saving;
}

function chart(history: readonly Turn[]): string {
  return barHeights(history.map((turn) => turn.spent))
    .map((height) => BARS[Math.min(BARS.length - 1, Math.floor(height * (BARS.length - 1)))])
    .join("");
}
