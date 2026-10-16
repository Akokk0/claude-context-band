// context-band:输入框上方的那一条 —— 上下文窗口的「天气」、账号的 5 小时与本周两个窗口,
// 上面是模型报上来的进度行和派出去的子代理。
//
// 窗口那一格是跟着回合走的:
// turn.start:一轮开始,卡片上此刻的读数就是起点 —— 这一轮涨了多少从它起算。
// session.compact:压缩过,窗口落下去了,读数和起点跟着落。
// turn.step:这一轮里每发完一次模型请求读一次,卡片在干活的时候就跟着动,不等答完。
//   用的是接口给这次请求报的账(进去的加出来的),回应流的过程中不动。
//   同一份账里还有缓存读了多少、写了多少:主对话的每次请求都记一笔,画成仪表底下那一条。
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

import type { Card, Limits, Reading, Row, Task, Turn } from "../types";
import { lifeOf, tickIn, withRequest } from "./cache";
import { IMAGE_HEIGHT, cardAlt, cardSvg } from "./card";
import {
  ROW_HEIGHT,
  completedOf,
  agentAlt,
  agentLine,
  agentSvg,
  bornOf,
  isForgotten,
  keptTasks,
  keptOf,
  handedFrom,
  isUserReply,
  lastReportOf,
  receiptOf,
  rowAlt,
  rowLine,
  rowOf,
  rowSvg,
  rowsFrom,
  tasksFrom,
  shownAgents,
  shownRows,
  statusOf,
  taskRow,
  withAgentEnd,
  withAgentStep,
  withoutEndedAgents,
  withReport,
  withSaved,
  withSpawn,
  withoutDecide,
  withoutDeadAgents,
  withoutGoneAgents,
  withoutStale,
  withPlan,
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

/**
 * 主循环这一轮的 Stop 报上来「还有活在等着」:后台命令、Monitor、后台子代理(background_tasks),
 * 或定时唤醒、重复执行的定时(session_crons)至少有一个。真机量过(桌面端内置 CLI 2.1.299):
 * 正常结束的回合 classic.Stop 先到、turn.complete 晚 30–120 毫秒到;用户点停止打断的回合不发 Stop;
 * 子代理收场走 SubagentStop、主循环的 Stop 不带 agent_id。所以没收到 Stop 就当不忙:
 * 不只是被打断的回合,API 出错(走 StopFailure)也一样。Stop 被别的钩子拦下、这一轮接着跑又被打断的话,
 * 用的是被拦下那次 Stop 记下的值。
 * 模块变量:回合结束取用后清掉;热加载丢了就当不忙。
 */
let busy = false;

/** 这一轮最后一次请求收完时窗口的读数,留给回合结束用。模块变量:热加载丢了就现读。 */
let landing: { turnId: string; now?: Reading; cached?: (shown: Card) => Card } | undefined;

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
    "之后每做完一步、换阶段、整件做完时各报一次。done 是一共做完了几步;同一件活每次用同一个 plan。" +
    "先报的行在下、后报的在上:一件大工程先报总进度、再报当前这一段,最下面就是总进度。" +
    "有桌面端任务列表的会话里,手上这一件的每一步由任务列表自动显示,这里只报总进度和当前大阶段两条,它们的一步就是一片、一个阶段。" +
    "回合结束时进度带会自己把最上面没做完的那一行切成等用户拍板,用户回话后自己回到工作中,收尾不用专门报。" +
    "派出去的子代理自己会有一行,不用替它报。" +
    "报进度要和那一步的真活(提交、派下一片等)放在同一条消息里发,不要单独占一轮。",
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
        description: "一般不用传:回合结束时进度带会自己切到等你拍板",
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
    "- **什么时候报**:开工时报一次(列出阶段和每阶段几步);每做完一步、换阶段、整件做完各报一次。有任务列表时,总和段这两条的「一步」就是一片、一个阶段,手上这件活的小步不用报。`done` 是一共做完了几步;同一件活每次用同一个 `plan`。",
    // 真机上量过:工具本身几乎不花时间,但单独发一次就多等一轮模型的回应,窗口大了以后是十几秒。
    "- **和下一步的动作同一条消息发**:报进度的调用和接下来要做的工具调用放在同一条消息里,不要单独占一轮。单独发一次,用户就要多等一轮模型的回应,看上去是进度条动了、人却卡着。",
    // 手上这一件交给桌面端的任务列表自动画,模型只报任务列表装不下的大进度。
    "- **有桌面端任务列表(`mcp__ccd_turn__update_plan`)时**:手上这件活的每一步,由任务列表自动显示在进度带最上面,不用再用 progress 一步步报。progress 只报任务列表装不下的大进度 —— 总进度和当前大阶段两条(先报总、再报段),换片、换阶段时报,和那一步的真活(提交、派下一片等)放在同一条消息里发。",
    "- **没有任务列表的会话里,大工程报三条,先大后细**:先报的行在下、后报的在上,所以按「总、段、件」的顺序报,最下面是总进度,越往上越细。「整个工程」每个大阶段列成一个阶段、各一步;「当前这个大阶段」只列一个阶段,里面每件活一步;「手上这一件」每个小件一个阶段,小件里再分步。只为算进度而存在的准备、勘察、开工不单列阶段。做完一个小件更新第三条;做完一整件更新第二条并换第三条;走完一个大阶段更新第一条。只做一件不属于大工程的小活时,报一条就够。",
    "- **行上的字由 mod 算**:胶囊写的是正在做的那个阶段的名字。行尾是一个分数,数的是做完的(刚开工是 0):只有一个阶段的显示「做完几步 / 共几步」;有好几个阶段的显示「做完几个阶段 / 共几个阶段」,眼下这个阶段自己还分步时,分数左边多一个小环,按这个阶段的步数切段、做完一步亮一段。上面三条依次是「1/7」「9/18」、带小环的「1/3」这三种。回执里那句话仍把后一种写成带小数点的「1.2/3」(做完 1 个阶段、眼下这个阶段做完 2 步、共 3 个阶段)。",
    "- **收尾不用专门报**:回合结束时,进度带会自己把最上面那一条没做完的行切成「等你拍板」(后台命令、子代理、Monitor、定时唤醒和定时任务在等着时不切),用户回话后自己回到工作中。停下来问用户、整件做完都不用专门报,也不用传 `status`。",
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
    // 盘上的还没接回来(盘读不了)时不落:拿状态里的去落会把盘上的盖掉,接回来时自会合并后落。
    if (shown.restored) await keep($, shown.rows ?? [], shown.tasks, shown.handed);
    // 「报进度」的工具放在最后注册:它注册不上(宿主不给)也不耽误仪表。同名再注册是覆盖,热加载无妨。
    try {
      await $.tool.register(PROGRESS);
    } catch {
      // 没有这个工具,进度行就一直是空的。
    }
    // 热加载之后原先等着的那个定时器跟着旧模块没了:缓存还有效的话重新定。
    await arm($);
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

  on("tool.call", { tool: "mcp__ccd_turn__update_plan" }, async ($, e, next) => {
    // 先放行:任务列表是宿主的,mod 只在旁边看,绝不改动或拦下它的结果。
    const result = await next(e);
    try {
      // 宿主拒绝或报错的调用,清单没有变:不记。
      if ("deny" in result && result.deny) return result;
      if (result.isError) return result;
      // 子代理的清单是它自己的,不画在主对话的带子上。
      if ((e as { agentId?: string }).agentId) return result;
      const input = e as unknown as Record<string, unknown>;
      // 落下去和原来一样的话不写状态:每写一次宿主就把整张图换一次。先看一眼,免得白走一趟 change。
      await restore($);
      const current = (await read($, card)).tasks?.items;
      if (withPlan(current, input) === current) return result;
      const at = await $.clock.now();
      await change($, (shown) => {
        const items = withPlan(shown.tasks?.items, input);
        if (items === shown.tasks?.items) return shown;
        return {
          ...shown,
          // 整份换新清单像 progress 行遇到新 plan:条从 0 起滑;增量取变动之前的完成数。
          tasks: items && {
            items,
            at,
            was: Array.isArray(input.items) ? 0 : completedOf(shown.tasks?.items),
          },
        };
      });
    } catch {
      // 看不懂就算了,不耽误任务列表本身。
    }
    return result;
  });

  on("tool.call", { tool: "mcp__ccd_turn__wrap_up" }, async ($, e, next) => {
    // 同上:先放行,只在旁边看。带 ask 是等用户拍板,不带是这一轮收尾、清单全部打勾。
    const result = await next(e);
    try {
      // 宿主拒绝或报错的调用,这一轮没有收尾:不记。
      if ("deny" in result && result.deny) return result;
      if (result.isError) return result;
      if ((e as { agentId?: string }).agentId) return result;
      const { ask } = e as unknown as { ask?: unknown };
      const asking = typeof ask === "string" && ask.trim() !== "";
      // 收尾落下去什么都不变的话不写状态(先看一眼,免得白走一趟 change)。
      const wrapped = (tasks: NonNullable<Card["tasks"]>, at: number): Card["tasks"] => {
        if (tasks.items.length === 0) return tasks;
        if (asking) return tasks.asking ? tasks : { ...tasks, asking: true };
        if (tasks.items.every((task) => task.status === "completed") && !tasks.asking) return tasks;
        const items = tasks.items.map((task): Task => ({ ...task, status: "completed" }));
        // 打勾这一刻记时刻、「之前」取打勾之前的完成数:条从当前位置滑到满,和 advance 一样。
        return { items, at, was: completedOf(tasks.items) };
      };
      await restore($);
      const current = (await read($, card)).tasks;
      if (!current || wrapped(current, 0) === current) return result;
      const at = await $.clock.now();
      await change($, (shown) => {
        const tasks = shown.tasks && wrapped(shown.tasks, at);
        return tasks === shown.tasks ? shown : { ...shown, tasks };
      });
    } catch {
      // 看不懂就算了。
    }
    return result;
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
    // 主人发话了:等拍板的行不用再等。只认用户回话(见 isUserReply,真机量过的来源):
    // 输入框里打的字(空闲时打的、干活时打的送进这一轮的、点收尾框按钮的)都是 composer;
    // 后台命令/Monitor 完成是 task-notification,后台子代理交回是 peer,定时唤醒是 scheduled-trigger,
    // 桌面端自己塞进来的(start_session 开场任务、别的会话 send_message)是 sdk —— 这些都不算回话,什么都不改、原样放行。
    // 后台的活回来开的那一轮,回合结束自动切的拍板由 turn.start 撤;wrap_up 的问题和模型传的 decide 要等用户真回话。
    if (!isUserReply(e.origin)) return next(e);
    await change($, (shown) => {
      const rows = withoutDecide(shown.rows ?? []);
      const { asking, ...tasks } = shown.tasks ?? { asking: undefined };
      const decided = rows !== (shown.rows ?? rows);
      if (!decided && !asking && !shown.handed) return shown;
      const { handed: _handed, ...rest } = shown;
      return {
        ...rest,
        ...(decided ? { rows } : {}),
        ...(shown.tasks ? { tasks: tasks as NonNullable<Card["tasks"]> } : {}),
      };
    });
    return next(e);
  });

  on("agent.spawn", async ($, e, next) => {
    const result = await next(e);
    const id = result.agentId;
    if (id) {
      const at = await $.clock.now();
      // 工作流派的子代理 background 是 false、带 workflow(类型里还没有这个字段)。
      // 宿主没明说 background 的不认作前台:认错了会把还在跑的收掉,不认只是照旧等一小时。
      const background = (e as { background?: boolean }).background;
      const kind = (e as { workflow?: unknown }).workflow
        ? "workflow"
        : background === true
          ? "background"
          : background === false
            ? "foreground"
            : undefined;
      await change($, (shown) => ({
        ...shown,
        agents: withSpawn(shown.agents ?? [], id, e.description, at, result.model, kind),
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
          // 对话换成了摘要,原来留在缓存里的那一段下一次本来就读不到:那一次重建不算没命中。
          cache: shown.cache && { ...shown.cache, held: 0 },
          gauge: now
            ? { now, was: now, base: now.tokens, at: measured.at || (shown.gauge?.at ?? 0) }
            : shown.gauge,
        };
      });
    }
    return result;
  });

  on("classic.Stop", async ($, e, next) => {
    // 只看主循环的 Stop(子代理的有 agent_id)。悄悄死掉的子代理不会在 background_tasks 里,所以忙不忙不看卡片上子代理那一行。
    // 这是能拦住停下的事件:自己这点记录绝不能抛,一律原样放行。
    try {
      if (!e.agent_id)
        busy = (e.background_tasks?.length ?? 0) > 0 || (e.session_crons?.length ?? 0) > 0;
    } catch {
      // 看不懂就当不忙。
    }
    // 同一刻对账子代理的行:没在 background_tasks 里的(悄悄死掉的)收起。这个字段没报上来就整个不对账。
    try {
      const tasks = e.agent_id ? undefined : e.background_tasks;
      if (tasks)
        await change($, (shown) => {
          const agents = withoutDeadAgents(shown.agents ?? [], tasks);
          return agents === (shown.agents ?? agents) ? shown : { ...shown, agents };
        });
    } catch {
      // 对不上账就留着,等一小时的清理。
    }
    return next(e);
  });

  on("turn.start", async ($, e, next) => {
    const result = await next(e);
    // 后台子代理开跑时也会触发一次 turn.start(事件里带 agentId):那不是主循环的新一轮,卡片什么都不动
    // (仪表起点、收起做完的行、清太久没动静的子代理、置在跑、撤回合结束切的拍板,这一套都只属于主循环)。
    if ((e as { agentId?: string }).agentId) return result;
    // 起点是卡片上已有的读数,不现读:宿主报的用量只算到上一次请求发出去时,不含那次回应,
    // 拿它当起点会把上一轮的回应算进这一轮(真机上撞过)。两轮之间压缩过的话,session.compact 那边已经把读数落下去了。
    // 「上一次画的」也拨到此刻,上一轮带进来的入场动画就不会跟着这次重画再播一遍。
    await draw($, await measure($), (shown, measured) => {
      const { now, at } = measured;
      const from = shown.gauge?.now ?? now;
      // 做完的行看过一轮了,新的一轮开始就收起;整条带太久没人报的话也全收起(多半是不做了)。
      // 留下的行「上一次画的」拨到此刻,不跟着这次重画再滑一遍。
      const open = (shown.rows ?? []).filter((row) => statusOf(row) !== "done");
      // 下一轮主循环开始:回合结束自动切的拍板撤掉(wrap_up 的问题、模型传的 decide 不归它管,留着)。
      const { handed: _handed, ...rest } = shown;
      return {
        ...rest,
        ...quotas(shown, measured),
        rows: settled(at ? withoutStale(open, at) : open),
        // 清单全做完了(收尾时打的勾),看过一轮了,新的一轮开始就收起;还在等用户回答的不收(后台的活回来开的轮不是用户回话,见 prompt.submit)。
        tasks:
          shown.tasks &&
          !shown.tasks.asking &&
          completedOf(shown.tasks.items) === shown.tasks.items.length
            ? undefined
            : shown.tasks,
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
        agents: withAgentStep(shown.agents ?? [], agentId, e.turnId, at, {
          model: e.model,
          effort: e.effort,
        }),
      }));
      return result;
    }
    // 以压缩收场的请求不是读数:它的账是压之前的大小,窗口随后就落下去了,落到多少由 session.compact 那边管。
    if (result.stopReason === "compaction") return result;
    const taken = await measure($);
    const measured = withBill(taken, result.usage);
    // 缓存的账每次请求都记:进去多少、读出来多少、这一刻起缓存又能用一整段。
    const bill = result.usage;
    const cached = (shown: Card): Card =>
      bill
        ? {
            ...shown,
            cache: withRequest(
              shown.cache,
              bill,
              taken.now?.tokens,
              measured.at,
              lifeOf({ ...shown.limits, ...measured.limits }),
            ),
          }
        : shown;
    if (result.stopReason !== "tool_use" && result.stopReason !== "pause_turn") {
      landing = { turnId: e.turnId, now: measured.now, cached };
    } else {
      await draw($, measured, (before) => {
        const shown = cached(before);
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
      await arm($);
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
      const cached = last?.cached ?? ((shown: Card) => shown);
      landing = undefined;
      // 取这一轮 Stop 记下的忙并清掉;被打断的回合没有 Stop,就是不忙 —— 用户刚亲手停了它,球该交回去。
      const isBusy = busy;
      busy = false;
      // 没读到数也要把「在跑」撤掉(被打断的那一轮常常这样),不然卡片一直是干活的样子。
      const taken = await measure($);
      const measured = landed ? { ...taken, now: landed } : taken;
      await draw($, measured, (before) => {
        // handed 每次按这一轮重算,不沿用旧的:旧的在这一轮忙的时候也该撤。
        const { handed: _old, ...shown } = cached(before);
        const { now, at } = measured;
        const agents = withoutEndedAgents(shown.agents ?? []);
        const rows = settled(shown.rows ?? []);
        const tasks = settledTasks(shown.tasks);
        // 这一轮答完了:该用户说话了。这一轮的 Stop 没报后台活和定时在等着、并且显示出来会有一条被切成「等你拍板」的话,记一笔 handed;
        // 行和任务列表本身不改,画的时候再推(见 handedOver)。什么都不用切就不写。
        const over = handedOver(rows, tasks);
        const isHanded = !isBusy && (over.rows !== rows || over.tasks !== tasks);
        // 没有读数:一种是没读到,一种是卡片上本来就没有、宿主也还说不出窗口用了多少。都只收尾,不记柱子。
        if (!now)
          return {
            ...shown,
            ...quotas(shown, measured),
            rows,
            tasks,
            agents,
            running: false,
            ...(isHanded ? { handed: true as const } : {}),
          };
        const spent = now.tokens - (shown.gauge?.base ?? now.tokens);
        return {
          ...shown,
          ...quotas(shown, measured),
          rows,
          tasks,
          agents,
          running: false,
          ...(isHanded ? { handed: true as const } : {}),
          turns: withTurn(shown.turns, { spent, percent: now.percent }),
          gauge: {
            now,
            was: shown.gauge?.now ?? now,
            base: now.tokens,
            at: at || (shown.gauge?.at ?? 0),
          },
        };
      });
      await arm($);
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
      rows: sentRows,
      agents: sent,
      tasks: savedTasks,
      handed,
      cache,
    } = await read($, card);
    // 回合结束交回用户:行和任务列表在状态里原样,画的时候才把最上面没做完的那条显示成等拍板。
    const { rows: all, tasks: sentTasks } = handed
      ? handedOver(sentRows ?? [], savedTasks)
      : { rows: sentRows ?? [], tasks: savedTasks };
    const tasks = taskRow(sentTasks);
    const rows = [...(tasks ? [tasks] : []), ...shownRows(all)];
    const agents = shownAgents(sent ?? []);
    if (e.props.hasSurvey || (!shown && rows.length === 0 && agents.length === 0)) {
      return next(e);
    }
    if (e.surface === "desktop") {
      const { Box, Svg } = $.ui.resolve(e);
      // 子代理的行在最上、进度行其次、仪表在最下面:行多了往上长,仪表的位置不动。每样各一张图。
      // 带里任何一样变了、带子被重画了(换会话再回来会连画两次,宿主推来额度读数也会画一次),宿主都会把这些图
      // 重新摆一遍、动画从头播(真机上用探针量过:一张内容从不变的图,也跟着别的图一起从头播)。
      // 所以两样都按「画的这一刻」算:循环动画的相位从这一刻起步,新摆上去的图正好接着旧图转到的地方;
      // 入场动画看这一刻离那张图自己上次变化过去了多久,播完了的不重播,播到一半的接着播。
      // (相位原先按带里最近一次变化的时刻算,指望「没变就是同一张图,宿主没东西可换」;量出来它照换不误。)
      const drawnAt = await $.clock.now();
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
              source={agentSvg(agent, { now: drawnAt })}
              alt={agentAlt(agent)}
              height={ROW_HEIGHT}
            />
          ))}
          {rows.map((row) => (
            <Svg
              source={rowSvg(row, { working: running, now: drawnAt, since: drawnAt - row.at })}
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
                now: drawnAt,
                since: drawnAt - shown.at,
                cache,
              })}
              alt={cardAlt(shown, history, quota, cache)}
              height={IMAGE_HEIGHT}
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

/**
 * 回合结束,球到用户这边(Card.handed)时带里显示成什么样:最上面(最细)那条没做完的行显示成「等你拍板」,更大的行不动。
 * 任务列表排在最上面,它没做完就切它;否则从最后报的往前找第一条没做完的 progress 行。
 * 只管显示成什么样:忙不忙由设 handed 的一方决定。什么都不用切、或者已经是了,原样交回。
 */
function handedOver(rows: Row[], tasks: Card["tasks"]): { rows: Row[]; tasks: Card["tasks"] } {
  const row = taskRow(tasks);
  if (tasks && row && statusOf(row) !== "done")
    return { rows, tasks: tasks.asking ? tasks : { ...tasks, asking: true } };
  const top = rows.findLastIndex((one) => statusOf(one) !== "done");
  if (top < 0 || rows[top]?.status === "decide") return { rows, tasks };
  return {
    rows: rows.map((one, i) => (i === top ? { ...one, status: "decide" as const } : one)),
    tasks,
  };
}

/** 任务列表那一行「上一次画的完成数」拨到此刻;什么都不用拨时原样交回。 */
function settledTasks(tasks: Card["tasks"]): Card["tasks"] {
  if (!tasks) return tasks;
  const done = completedOf(tasks.items);
  return tasks.was === done ? tasks : { ...tasks, was: done };
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

/** 行和任务列表里要落盘的那些,写成一串字:比「变了没有」用。 */
const kept = (shown: Pick<Card, "rows" | "tasks" | "handed">) =>
  JSON.stringify([keptOf(shown.rows ?? []), keptTasks(shown.tasks), shown.handed === true]);

/**
 * 卡片的每一次写都从这儿过。
 * 写之前:盘上的还没接回来(进程刚起来),先接 —— 接回来之前状态照改、但不落盘,不然会把盘上的盖掉。
 * 写之后:行变了、并且盘上的接回来了,就落盘。每次变都落,不等会话结束:应用被关掉时会话结束那一下不一定走得到。
 */
async function change($: EngineInterface, next: (shown: Card) => Card): Promise<Card> {
  await restore($);
  let moved = false;
  const written = await update($, card, (shown) => {
    const drawn = next(shown);
    moved = kept(drawn) !== kept(shown);
    return drawn;
  });
  if (moved && written.restored) await keep($, written.rows ?? [], written.tasks, written.handed);
  return written;
}

/**
 * 进程刚起来(应用重启后续上会话):把盘上这个会话的行和任务列表接回来。
 * 接没接回来记在状态里(restored),不看有没有行、也不在模块里记「接过了」:
 * 读盘失败那阵子别处会把行写成空的,而热加载会清模块变量、状态里的 restored 还在。
 * 接回来只靠自己那份:读到了就接,别的会话的键读不读得了都不相干。
 * 自己的 id 底下什么都没有时,才得把别的键都读上,找这场对话从前留下的那份(见 inherited);这一步读盘失败什么都不改。
 * 接成了把盘上的和状态里已有的合起来(见 withSaved)。读盘失败、restored 不置,下一次写之前再试。
 */
async function restore($: EngineInterface): Promise<void> {
  if ((await read($, card)).restored) return;
  let others: Map<string, unknown> | undefined;
  let past: string | undefined;
  let added = false;
  let written: Card;
  try {
    const mine = keyOf(await $.session.id());
    const ownSaved = await $.store.get(mine);
    let rows = rowsFrom(ownSaved);
    let tasks = tasksFrom(ownSaved);
    let handed = handedFrom(ownSaved);
    if (rows.length === 0 && !tasks) {
      others = await othersOf($, mine);
      past = inherited(others, await born($));
      if (past) {
        rows = rowsFrom(others.get(past));
        tasks = tasksFrom(others.get(past));
        handed = handedFrom(others.get(past));
      }
    }
    // 在此刻的状态上合,不拿先读出来的那份写回去:读和写之间别处可能已经写过了。
    written = await update($, card, (shown) => {
      // 同时到的另一次已经抢先接上了:这次手里的是它接上之前读的旧内容,再合一遍会把那之后撤掉的行带回来。
      if (shown.restored) return shown;
      // 接回来之前状态里就有行或任务列表(读盘失败那阵子添的):合并后得落一次盘。
      added = (shown.rows?.length ?? 0) > 0 || !!shown.tasks;
      return {
        ...shown,
        rows: withSaved(rows, shown.rows ?? []),
        ...(shown.tasks || !tasks ? {} : { tasks }),
        // 进程刚起来,状态里还没有;有盘上的就用盘上的。
        // 回合正在跑就不接:盘上的 handed 不可能是这一轮的(下一轮 turn.start 本来就会撤),接了模型干活时会显示等你拍板。
        ...(shown.handed || !handed || shown.running ? {} : { handed }),
        restored: true,
      };
    });
  } catch {
    // 自己那份(或找旧 id 要读的别的键)读不了,或状态没写成:什么都没改、restored 不置,下一次写之前再试。
    return;
  }
  // 接回来了。下面是善后,失败了也不影响已经接上的行:清理的下回进程起来接着清,搬家没删成的旧键也留到那时。
  try {
    if (past || added) {
      // 落的是状态里此刻的行,不是刚读出来的那份:同时到的另一件活可能已经先接回来、还添了行。
      const saved = await keep($, written.rows ?? [], written.tasks, written.handed);
      // 搬到自己的 id 底下,旧的那份删掉:留着的话,这边把行撤光之后再被换一次 id,撤掉的行又会从它那儿回来。
      // 但新的那份没写成就不能删:两份都没了就再也接不回来。
      if (past && saved) await $.store.delete(past);
    }
    await sweep($, keyOf(await $.session.id()), others, past);
  } catch {
    // 盘上出了岔子:行已经在状态里,善后留到下回。
  }
}

/** 盘上别的会话的键和它们的内容;读不上就整个抛出去(找旧 id 要的是全的)。 */
async function othersOf($: EngineInterface, mine: string): Promise<Map<string, unknown>> {
  const others = new Map<string, unknown>();
  for (const key of await $.store.keys())
    if (key !== mine && key.startsWith(ROWS)) others.set(key, await $.store.get(key));
  return others;
}

/**
 * 把别的会话留在盘上、没人管了的行清掉:进程起来时清一回就够。
 * 找旧 id 时读过的内容(known)直接用;没读过的一个一个读,哪个读不了就跳过它,不拦着别的。
 */
async function sweep(
  $: EngineInterface,
  mine: string,
  known: ReadonlyMap<string, unknown> | undefined,
  moved: string | undefined,
): Promise<void> {
  const now = await $.clock.now();
  for (const key of await $.store.keys()) {
    if (key === mine || key === moved || !key.startsWith(ROWS)) continue;
    try {
      const saved = known?.has(key) ? known.get(key) : await $.store.get(key);
      if (isForgotten(rowsFrom(saved), now, tasksFrom(saved))) await $.store.delete(key);
    } catch {
      // 这一个读不了或删不掉:留着,下回进程起来再清。
    }
  }
}

/** 这场对话头一回开始的时刻;宿主说不出来就是不知道。续上的对话报的还是头一回那个时刻。 */
async function born($: EngineInterface): Promise<number | undefined> {
  try {
    return bornOf({ born: (await $.session.usage()).startedAt });
  } catch {
    return undefined;
  }
}

/**
 * 这场对话从前在别的会话 id 底下留的那份行,是盘上的哪个键。
 * 被打断后再续上、关掉应用再开,宿主都可能给对话换一个新 id(真机上一场对话三天换了三回),
 * 按 id 找就扑空;同一场对话头一回开始的时刻不变,按它认。有好几份时拿最后有人报过的那份。
 */
function inherited(
  others: ReadonlyMap<string, unknown>,
  mine: number | undefined,
): string | undefined {
  if (mine === undefined) return undefined;
  let found: { key: string; last: number } | undefined;
  for (const [key, saved] of others) {
    if (bornOf(saved) !== mine) continue;
    const last = lastReportOf(rowsFrom(saved), tasksFrom(saved));
    if (!found || last > found.last) found = { key, last };
  }
  return found?.key;
}

/** 缓存那一条等着的下一回重画,和它是第几回定的(后定的作数)。模块变量:热加载丢了就在会话开始时重新定。 */
let ticking: { cancel: () => void } | undefined;
let armed = 0;

/**
 * 缓存还有效的时候,带子每分钟自己重画一回:分钟数一变就画,过期那一下画最后一回,之后不再画。
 * 没有它的话,闲着时没人重画带子,那一条全靠图自己的动画走;应用窗口被挡住时动画是停的,
 * 回来后线比实际长(主人在真带子上看到的)。
 * 每收完一次主对话的请求重新定一回(缓存回满了,分钟从这一刻起数),原先等着的那个作废。
 */
async function arm($: EngineInterface): Promise<void> {
  const mine = ++armed;
  ticking?.cancel();
  ticking = undefined;
  try {
    const { cache } = await read($, card);
    if (!cache) return;
    const left = cache.at + cache.life - (await $.clock.now());
    // 读钟的工夫别处又定了一回:让后定的那个作数。
    if (left <= 0 || mine !== armed) return;
    // 作废的那个不用在这里再拦一道:重新定的时候已经 cancel 了,cancel 过的不会再到点。
    ticking = $.clock.after(tickIn(left), () => {
      $.ui.invalidate("ui.render");
      void arm($);
    });
  } catch {
    // 定不上(宿主不给定时器):那一条退回到只靠图自己的动画走。
  }
}

/** 落盘排着队来:两件活同时报,后落进状态的那一份也后落盘,盘上留下的一定是最新的。 */
let saving: Promise<void> = Promise.resolve();

/**
 * 行和任务列表落盘;一样都不剩就把这个会话那份删掉。
 * 写不了(盘满了、宿主出了岔子)就算了:行还在状态里,只是重启后接不回来,不能让报进度因此坏掉。
 * 交回写成没成:搬家要看它,别处不看。
 */
function keep(
  $: EngineInterface,
  rows: readonly Row[],
  tasks?: Parameters<typeof keptTasks>[0],
  handed?: true,
): Promise<boolean> {
  const saved = saving.then(async () => {
    try {
      const key = keyOf(await $.session.id());
      if (rows.length === 0 && !tasks) await $.store.delete(key);
      else
        await $.store.set(key, {
          born: await born($),
          rows: keptOf(rows),
          tasks: keptTasks(tasks),
          ...(handed ? { handed: true } : {}),
        });
      return true;
    } catch {
      // 盘上那份停在上一次写成的样子。
      return false;
    }
  });
  saving = saved.then(() => {});
  return saved;
}

function chart(history: readonly Turn[]): string {
  return barHeights(history.map((turn) => turn.spent))
    .map((height) => BARS[Math.min(BARS.length - 1, Math.floor(height * (BARS.length - 1)))])
    .join("");
}
