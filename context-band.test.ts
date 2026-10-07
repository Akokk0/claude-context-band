import { expect, test } from "claude-code/testing";
import type { Engine } from "claude-code/testing";
import type { On } from "claude-code";

const BAND = {
  plugin: "context-band",
  component: "AbovePrompt",
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const;

const START = { cwd: "/repo", surface: "terminal", isInteractive: true } as const;
const TURN = {
  answer: "ok",
  durationMs: 1,
  isAborted: false,
  turnId: "t",
  reason: "answer",
} as const;
const STEP = { turnId: "t", index: 0, model: "m", messageCount: 1 } as const;

/** 引擎那一层的此刻。 */
const NOW = Date.parse("2026-10-04T04:26:00.000Z");
const DAY = 24 * 3_600_000;
/** 测试里的钟:要让时间走,就改它。 */
const clock = { now: NOW, reads: 0 };
/** 下一次模型请求的回应,一段一段流出来的那些片段。 */
type Piece =
  | { kind: "text" | "thinking"; index: number; text: string }
  | { kind: "input"; index: number; json: string };
/** `silent`:宿主这会儿报不出窗口用量(请求收完时读不到准数),卡片上留着的就是估出来的。 */
/** `last`:这次请求是这一轮的最后一次(模型答完了,不再调工具)。 */
/**
 * `bill`:接口给这次请求报的账。输入那三样加起来是请求发出去时窗口里有多少,输出是这次回应有多少。
 * 不给的话这次请求就没有账(测试里大多数用例只看宿主报的用量)。
 */
type Bill = {
  input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  output_tokens: number;
  model: string;
};
/** `quietAfter`:宿主再报这么多次用量之后就报不出来了(用来看流到一半时卡片上是什么)。 */
/** `stop`:这次请求为什么停(不给就按 `last` 来);`after`:压缩之后宿主说窗口里还剩多少。 */
const wire = {
  pieces: [] as Piece[],
  silent: false,
  last: false,
  bill: null as Bill | null,
  quietAfter: Number.POSITIVE_INFINITY,
  stop: null as string | null,
  after: undefined as number | undefined,
};
/** 每次读宿主的用量之前叫一声,测试用它在读到一半时让宿主改口。 */
const reads = { onRead: (): void | Promise<void> => {} };
const SUMMARY = { role: "user" as const, text: "summary", toolUses: [] };
/** 下一次压缩是真压了,还是被跳过了。 */
const compacted = { done: false };
const billOf = (input: number, output: number): Bill => ({
  input_tokens: 12,
  cache_read_input_tokens: input - 512,
  cache_creation_input_tokens: 500,
  output_tokens: output,
  model: "m",
});

/**
 * 宿主那一半里跨进程的东西:盘(`$.store` 写到这儿,进程重启也留着)和会话 id(续上的还是同一个)。
 * `isStateLost`:进程重启过,宿主替会话存着的状态没了。`isDiskDown`:盘读写不了。`isDiskUnreadable`:盘只是读不了,写还行。
 * `writes`:往盘上写(含删)过几回。
 * `onWrite`:每次往盘上写之前叫一声,测试用它让某一次写慢下来。
 */
const host = {
  disk: new Map<string, unknown>(),
  session: "s-1",
  isStateLost: false,
  isDiskDown: false,
  isDiskUnreadable: false,
  writes: 0,
  onWrite: (): void | Promise<void> => {},
  tools: [] as unknown[],
};

/** 盘上的一次读写:盘坏了就抛。 */
function onDisk<T>(act: () => T, kind: "read" | "write" = "write"): T {
  if (host.isDiskDown || (kind === "read" && host.isDiskUnreadable)) throw new Error("disk down");
  return act();
}

type Limit = { kind: string; percentUsed: number; resetsAt?: string };

/** 主人账号下读到的两个窗口:5 小时还剩 2 小时 14 分,本周还剩 4 天多。 */
const LIMITS: Limit[] = [
  { kind: "five_hour", percentUsed: 23, resetsAt: "2026-10-04T06:40:00.000Z" },
  { kind: "seven_day", percentUsed: 29.4, resetsAt: "2026-10-08T12:00:00.000Z" },
];

/** 引擎那一层的 `$.session.usage()`:窗口 200k,用了 `tokens`。 */
const usageOf = (tokens: number, rateLimits: readonly Limit[]) => ({
  startedAt: 0,
  // 负数:宿主还不知道窗口用了多少(这个窗口里还没有回应报过),只知道窗口多大。
  context:
    tokens < 0
      ? { window: 200_000 }
      : { tokens, window: 200_000, percent: Math.round((tokens / 200_000) * 100) },
  rateLimits,
});

/**
 * 让会话开始、再答完几轮。`tokens[0]` 是会话开始那一刻的窗口用量,
 * 之后每个数是又一轮答完时的用量。回一个函数,用来改下一次读到的用量(和额度窗口)。
 */
async function sessionAfter(
  $: Engine,
  on: On,
  tokens: readonly number[],
  limits: readonly Limit[] = [],
) {
  let used = tokens[0];
  let rateLimits = limits;
  on("session.start", async (_, e) => ({ cwd: e.cwd }));
  host.disk.clear();
  host.session = "s-1";
  host.isStateLost = false;
  host.isDiskDown = false;
  host.isDiskUnreadable = false;
  host.writes = 0;
  host.onWrite = () => {};
  host.tools = [];
  on("session.id", async () => ({ value: host.session }));
  on("store.get", async (_, e) => ({ value: onDisk(() => host.disk.get(e.key), "read") }));
  on("store.set", async (_, e) => {
    await host.onWrite();
    return {
      value: onDisk(
        () => void (host.writes++, host.disk.set(e.key, JSON.parse(JSON.stringify(e.value)))),
      ),
    };
  });
  on("store.delete", async (_, e) => ({
    value: onDisk(() => void (host.writes++, host.disk.delete(e.key))),
  }));
  on("store.keys", async () => ({ value: onDisk(() => [...host.disk.keys()], "read") }));
  // 宿主替会话存着的状态还是引擎自己那份,这里只在「进程重启过」之后把它读成从没写过,直到下一次写落下去。
  on("state.get", async (_, e, next) => {
    const held = await next(e);
    return host.isStateLost ? { value: { value: undefined, version: held.value.version } } : held;
  });
  on("state.set", async (_, e, next) => {
    const set = await next(e);
    if (set.value.isSet) host.isStateLost = false;
    return set;
  });
  on("tool.register", async (_, e) => {
    host.tools.push(e);
    return { value: undefined };
  });
  on("session.measure", async (_, e) => ({ changed: [...e.changed] }));
  on("turn.start", async (_, e) => ({ turnId: e.turnId }));
  wire.pieces = [];
  wire.silent = false;
  wire.last = false;
  wire.bill = null;
  wire.quietAfter = Number.POSITIVE_INFINITY;
  wire.stop = null;
  wire.after = undefined;
  on("session.end", async (_, e) => ({ sessionId: e.sessionId }));
  on("agent.spawn", async () => ({ model: "m", agentId: spawned.id }));
  on("prompt.submit", async (_, e) => ({ text: e.text }));
  reads.onRead = () => {};
  compacted.done = false;
  on("session.compact", async () =>
    compacted.done ? { messages: [SUMMARY], tokensAfter: wire.after } : { skip: "test" },
  );
  on("turn.step", async function* (_, e) {
    yield* wire.pieces;
    return {
      turnId: e.turnId,
      index: e.index,
      answer: "",
      toolUses: [],
      stopReason: (wire.stop ?? (wire.last ? "end_turn" : "tool_use")) as "tool_use",
      usage: wire.bill,
    };
  });
  on("turn.complete", async () => ({ text: "" }));
  on("session.usage", async () => {
    await reads.onRead();
    wire.quietAfter -= 1;
    return {
      value:
        wire.silent || wire.quietAfter < 0
          ? { startedAt: 0, context: {}, rateLimits }
          : usageOf(used, rateLimits),
    };
  });
  clock.now = NOW;
  on("clock.now", async () => {
    clock.reads += 1;
    return { value: clock.now };
  });
  await $.session.start(START);
  for (const next of tokens.slice(1)) {
    used = next;
    await $.turn.complete(TURN);
  }
  return (next: number, nextLimits?: readonly Limit[]) => {
    used = next;
    if (nextLimits) rateLimits = nextLimits;
  };
}

/** 下一个派出去的子代理叫什么。 */
const spawned = { id: "agent-1" };

/** 主人发了一句话:一轮开始。 */
const begin = ($: Engine) => $.turn.start({ text: "go", turnId: "t" });

/** 这一轮里的一次模型请求,从发出到整个回应收完。 */
async function step($: Engine, input: Partial<typeof STEP> & { agentId?: string } = {}) {
  const stream = $.turn.step({ ...STEP, ...input });
  for await (const _ of stream) {
    // 测试不看流里的片段。
  }
  return stream.result;
}

const cardOn = async ($: Engine, props: Partial<(typeof BAND)["props"]> = {}) => {
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, ...props }, surface: "desktop" });
  const card = await ui.find({ type: "Svg" });
  await ui.unmount();
  return card;
};

const sourceOn = async ($: Engine, props: Partial<(typeof BAND)["props"]> = {}) =>
  String((await cardOn($, props))?.props.source);

/** 卡片里每根柱子是哪一档,按从旧到新。 */
const barLevels = (source: string) =>
  [...source.matchAll(/class="cw-bar lv-([a-z]+)/g)].map((m) => m[1]);

/** 答完的那几轮各自的柱高,按从旧到新。 */
const barHeights = (source: string) =>
  [...source.matchAll(/class="cw-bar [^"]*"[^>]* height="(\d+)"/g)].map((m) => Number(m[1]));

/** 正在跑的这一轮那根虚柱的高度;没有就是 undefined。 */
const ghostHeight = (source: string) => {
  const found = /class="cw-ghost[^"]*"[^>]* height="(\d+)"/.exec(source);
  return found ? Number(found[1]) : undefined;
};

/** 柱子上面那个数:这一轮(或上一轮)让窗口涨了多少。正在跳的话,是它最后停下的那个数。 */
const spentOn = (source: string) =>
  [...source.matchAll(/class="cw-spent[^"]*"[^>]*>([^<]*)</g)].pop()?.[1];

test("the terminal band says the forecast in one line", async ($, on) => {
  await sessionAfter($, on, [36_400]);

  const ui = await $.ui.mount({ ...BAND, surface: "terminal" });
  expect(await ui.find({ type: "Text", text: /晴朗/ })).toBeDefined();
  expect(await ui.find({ type: "Text", text: /上下文 18%/ })).toBeDefined();
  expect(await ui.find({ type: "Text", text: /36\.4k \/ 200k/ })).toBeDefined();
  await ui.unmount();
});

test("the desktop band is one card that says the forecast", async ($, on) => {
  await sessionAfter($, on, [36_400]);

  const card = await cardOn($);
  expect(card?.props.alt).toBe("晴朗:上下文 18%,36.4k / 200k");
  const source = String(card?.props.source);
  expect(source).toContain(">晴朗<");
  expect(source).toContain(">18%<");
  expect(source).toContain(">上下文 36.4k / 200k<");
});

test("the card is drawn as an image as wide as the band and as tall as the row, whether a turn runs or not", async ($, on) => {
  await sessionAfter($, on, [36_400]);

  for (const isWorking of [false, true]) {
    const card = await cardOn($, { isWorking });
    // 当图片画,不画在沙箱框里:框每换一次内容要重载一次,整张卡片跟着闪(真机上撞过,探针对比过)。
    expect(card?.props.isInteractive).toBeUndefined();
    // 高度必须给:宿主不会从 SVG 里读,不给就是 150 高、内容缩在里面。
    // 宽度不给:给了固定宽度的话它会贴在左边,右边空一截。
    expect(card?.props.width).toBeUndefined();
    expect(card?.props.height).toBe(56);
    expect(String(card?.props.source)).toContain('viewBox="-8 0 696 56" width="696" height="56"');
  }
});

test("the frame sits in a column that stretches it across the band", async ($, on) => {
  await sessionAfter($, on, [36_400]);

  // Svg 直接当根的话,只给高度时框是默认的 300 宽,内容缩成四成(真机撞过);
  // 套一层竖排的 Box,它把里面的框拉到和这一条一样宽。
  const ui = await $.ui.mount({ ...BAND, surface: "desktop" });
  const column = await ui.find({ type: "Box" });
  expect(column?.props.flexDirection).toBe("column");
  expect(column?.children.map((child) => (child as { type?: string }).type)).toEqual(["Svg"]);
  await ui.unmount();
});

test("the card paints no ground of its own: the host's band shows through a see-through frame", async ($, on) => {
  await sessionAfter($, on, [36_400], LIMITS);

  const source = await sourceOn($, { isWorking: true });
  expect(source).not.toContain("cw-glass");
  expect(source).not.toContain("<filter");
  expect(source).not.toContain("sky");
  expect(source).toContain(":root{color-scheme:light dark}");
});

test("the forecast follows the window as turns complete, one bar a turn", async ($, on) => {
  await sessionAfter($, on, [0, 36_400, 134_400, 162_000]);

  const card = await cardOn($);
  expect(card?.props.alt).toBe("雷暴:上下文 81%,162k / 200k,+27.6k");
  expect(barLevels(String(card?.props.source))).toEqual(["clear", "showers", "storm"]);
});

test("a bar is as tall as what its own turn added to the window, not as the window is full", async ($, on) => {
  // 三轮各涨了 36.4k、98k、27.6k:最高的是中间那一轮,窗口最满的最后一轮反而最矮。
  await sessionAfter($, on, [0, 36_400, 134_400, 162_000]);

  const source = await sourceOn($);
  expect(barHeights(source)).toEqual([6, 17, 5]);
  expect(spentOn(source)).toBe("+27.6k");
});

test("a turn the window shrank in, a compaction, is a stub of a bar and reads as a drop", async ($, on) => {
  await sessionAfter($, on, [0, 160_000, 40_000]);

  const source = await sourceOn($);
  expect(barHeights(source)).toEqual([17, 3]);
  expect(spentOn(source)).toBe("−120k");
});

test("a session picked up half full counts only what its own turns add", async ($, on) => {
  await sessionAfter($, on, [120_000, 130_000]);

  expect(spentOn(await sourceOn($))).toBe("+10k");
});

test("the card follows the window while a turn runs: every model request moves it", async ($, on) => {
  const use = await sessionAfter($, on, [0, 36_400]);
  await begin($);
  use(100_000);
  await step($);

  const card = await cardOn($, { isWorking: true });
  expect(card?.props.alt).toBe("阵雨:上下文 50%,100k / 200k,+36.4k");
  const source = String(card?.props.source);
  expect(source).toContain(">上下文 100k / 200k<");
  // 答完的那一轮涨了 36.4k,正在跑的这一轮已经涨了 63.6k:虚柱是最高的那根。
  expect(spentOn(source)).toBe("+63.6k");
  expect(barHeights(source)).toEqual([10]);
  expect(ghostHeight(source)).toBe(17);
});

test("what a response wrote counts as soon as it has arrived: the window is what went in plus what came out", async ($, on) => {
  // 宿主报的用量只算到「这次请求发出去时」,不含这次回应本身(真机上撞过:估了 +800,落下来成了 +168)。
  // 接口给这次请求报的账里两样都有:进去 36 568,出来 1 000。
  const use = await sessionAfter($, on, [0, 36_400]);
  await begin($);
  use(36_568);
  wire.bill = billOf(36_568, 1_000);
  await step($);

  const source = await sourceOn($);
  expect(spentOn(source)).toBe("+1.2k");
  expect(source).toContain(">上下文 37.6k / 200k<");
});

test("the turn lands on what its last response left in the window, and the next turn counts from there", async ($, on) => {
  const use = await sessionAfter($, on, [0, 36_400]);
  await begin($);
  use(36_568);
  wire.bill = billOf(36_568, 1_000);
  wire.last = true;
  await step($);
  await $.turn.complete(TURN);
  expect(spentOn(await sourceOn($))).toBe("+1.2k");

  // 下一轮:宿主这会儿报的还是上一次请求发出去时的数(36 568),不能拿它当起点。
  wire.last = false;
  await begin($);
  use(37_800);
  wire.bill = billOf(37_800, 200);
  await step($);
  expect(spentOn(await sourceOn($))).toBe("+432");
});

test("a compaction between turns moves the starting point down with the window", async ($, on) => {
  const use = await sessionAfter($, on, [0, 160_000]);
  // 压缩过:窗口从 160k 落到 40k。新的一轮从 40k 起算。
  use(40_000);
  compacted.done = true;
  await $.session.compact({ trigger: "manual", messages: [SUMMARY] });
  await begin($);
  use(52_000);
  await step($);

  expect(spentOn(await sourceOn($))).toBe("+12k");
});

test("a compaction that was skipped leaves the card alone", async ($, on) => {
  const use = await sessionAfter($, on, [0, 160_000]);
  use(40_000);
  await $.session.compact({ trigger: "manual", messages: [SUMMARY] });

  expect(await sourceOn($)).toContain(">上下文 160k / 200k<");
});

test("when the turn completes its bar stays as tall as it grew", async ($, on) => {
  const use = await sessionAfter($, on, [0, 36_400]);
  await begin($);
  use(100_000);
  await step($);
  await $.turn.complete(TURN);

  const source = await sourceOn($);
  expect(barHeights(source)).toEqual([10, 17]);
  expect(ghostHeight(source)).toBeUndefined();
  expect(spentOn(source)).toBe("+63.6k");
});

test("the turn completing brings nothing in with a flourish: the quota numbers just stand there", async ($, on) => {
  await sessionAfter($, on, [0, 36_400, 44_000], LIMITS);

  const landed = await sourceOn($);
  expect(landed).toContain('class="cw-num g-h"');
  expect(landed).toContain('class="cw-num g-w"');
  expect(landed).not.toContain('cw-rise"');
});

test("the card goes by its own record of the turn, not by the host's working flag: no half-way picture when the two disagree", async ($, on) => {
  const use = await sessionAfter($, on, [0, 36_400]);
  // 回合结束时,宿主撤掉「在干活」和这一轮记成柱子,两件事先后不定。
  // 卡片要是两样都看,中间会画出一张半截的图,几毫秒后再换成对的 —— 真机上看到的就是闪一下。
  expect(await sourceOn($, { isWorking: true })).toBe(await sourceOn($));

  await begin($);
  use(60_000);
  await step($);
  const running = await sourceOn($, { isWorking: true });
  expect(running).toContain('class="cw-card is-working"');
  expect(await sourceOn($)).toBe(running);

  await $.turn.complete(TURN);
  const landed = await sourceOn($);
  expect(landed).not.toContain('class="cw-card is-working"');
  expect(await sourceOn($, { isWorking: true })).toBe(landed);
});

test("the last request of a turn leaves the card to the turn completing: one change, not two in a row", async ($, on) => {
  const use = await sessionAfter($, on, [0, 36_400]);
  await begin($);
  const before = await sourceOn($);
  wire.last = true;
  use(36_928);
  await step($);
  expect(await sourceOn($)).toBe(before);

  await $.turn.complete(TURN);
  expect(spentOn(await sourceOn($))).toBe("+528");
});

test("a turn that was interrupted still comes to rest", async ($, on) => {
  await sessionAfter($, on, [0, 36_400]);
  await begin($);
  // 被打断时宿主常常报不出用量。
  wire.silent = true;
  await $.turn.complete({ ...TURN, isAborted: true, reason: "aborted" });

  expect(await sourceOn($)).not.toContain('class="cw-card is-working"');
});

test("the turn landing is not a hard cut: the number rolls to the final count and the bar grows to its height", async ($, on) => {
  const use = await sessionAfter($, on, [0, 36_400]);
  await begin($);
  use(60_000);
  await step($);
  expect(spentOn(await sourceOn($))).toBe("+23.6k");

  // 最后一次请求把窗口推到 70k:答完时上方的数从 +23.6k 滚到 +33.6k,这一轮的柱子从 11 高长到 16 高。
  wire.last = true;
  use(70_000);
  await step($);
  await $.turn.complete(TURN);
  const landed = await sourceOn($);
  expect(framesOf(landed, "cw-spent cw-sub")).toEqual(["cw-out +23.6k", "cw-in +33.6k"]);
  expect(barHeights(landed)).toEqual([17, 16]);
  expect(landed).toContain('class="cw-bar lv-cloudy cw-stretch"');
  expect(landed).toContain("@keyframes cw-stretch{from{transform:scaleY(0.688)}");
});

test("while a response streams the card stays put: only the exact count at the end of a request moves it", async ($, on) => {
  // 主人试过边流边估:一个回应里数字要变好几回,乱跳。定下来只用请求收完时的准数。
  const use = await sessionAfter($, on, [0, 36_400]);
  await begin($);
  const before = await sourceOn($);
  wire.pieces = [
    { kind: "thinking", index: 0, text: "x".repeat(4_000) },
    { kind: "text", index: 1, text: "字".repeat(1_000) },
    { kind: "input", index: 2, json: "y".repeat(4_000) },
  ];
  // 请求收完时宿主报不出数:卡片上要是有变化,只能是流的时候动的。
  wire.silent = true;
  const reads = clock.reads;
  await step($);
  // 整个请求只在收完时读了一次用量,流的过程中一次都没读。(先数再画:画的时候也要读一次钟。)
  expect(clock.reads - reads).toBe(1);
  expect(await sourceOn($)).toBe(before);

  wire.silent = false;
  wire.pieces = [];
  use(40_000);
  await step($);
  expect(spentOn(await sourceOn($))).toBe("+3.6k");
});

test("a subagent's model request leaves the gauges alone", async ($, on) => {
  const use = await sessionAfter($, on, [36_400]);
  await begin($);
  wire.pieces = [
    { kind: "text", index: 0, text: "x".repeat(4000) },
    { kind: "text", index: 0, text: "x" },
  ];
  use(162_000);
  await step($, { agentId: "agent-1" });

  const stack = await stackOn($);
  expect(stack[stack.length - 1].alt).toBe("晴朗:上下文 18%,36.4k / 200k");
});

test("a quota window that moves mid-turn moves on the card", async ($, on) => {
  await sessionAfter($, on, [36_400], LIMITS);
  await $.session.measure({
    context: usageOf(36_400, []).context,
    rateLimits: [{ kind: "five_hour", percentUsed: 61, resetsAt: "2026-10-04T06:40:00.000Z" }],
    changed: ["rateLimits"],
  });

  // 这一次只带了 5 小时那一个窗口:本周那一格留着原来的,不抹掉。
  expect((await cardOn($, { isWorking: true }))?.props.alt).toBe(
    "晴朗:上下文 18%,36.4k / 200k;5 小时 61%;本周 29%",
  );
});

for (const [tokens, word] of [
  [48_000, "晴朗"],
  [50_000, "多云"],
  [98_000, "多云"],
  [100_000, "阵雨"],
  [148_000, "阵雨"],
  [150_000, "雷暴"],
  [178_000, "雷暴"],
  [180_000, "龙卷风"],
] as const) {
  test(`${tokens / 2000}% of the window reads ${word}`, async ($, on) => {
    await sessionAfter($, on, [tokens]);
    expect(String((await cardOn($))?.props.alt).split(":")[0]).toBe(word);
  });
}

test("a subagent's turn leaves the forecast alone", async ($, on) => {
  const use = await sessionAfter($, on, [36_400]);
  use(162_000);
  await $.turn.complete({ ...TURN, agentId: "agent-1" });

  expect((await cardOn($))?.props.alt).toBe("晴朗:上下文 18%,36.4k / 200k");
});

test("a reload of the mod does not add a bar", async ($, on) => {
  await sessionAfter($, on, [0, 36_400]);
  await $.session.start(START);

  expect(barLevels(await sourceOn($))).toEqual(["clear"]);
});

test("a reload of the mod reads the window and the quota windows again, still without adding a bar", async ($, on) => {
  const use = await sessionAfter($, on, [0, 36_400]);
  use(60_000, LIMITS);
  await $.session.start(START);

  const card = await cardOn($);
  expect(card?.props.alt).toBe("多云:上下文 30%,60k / 200k,+36.4k;5 小时 23%;本周 29%");
  expect(barLevels(String(card?.props.source))).toEqual(["clear"]);
});

test("a reload in the middle of a turn keeps counting the turn from where it began", async ($, on) => {
  const use = await sessionAfter($, on, [0, 36_400]);
  await begin($);
  use(60_000);
  await step($);
  await $.session.start(START);

  expect(spentOn(await sourceOn($, { isWorking: true }))).toBe("+23.6k");
});

test("a running turn shows in the pending bar and the ambient motion alone, with no dot on the corner of the icon; an idle card has neither", async ($, on) => {
  await sessionAfter($, on, [120_000]);

  const idle = await sourceOn($);
  expect(idle).not.toContain('class="cw-ghost');
  expect(idle).not.toContain('class="cw-card is-working"');

  await begin($);
  const working = await sourceOn($, { isWorking: true });
  expect(working).toContain('class="cw-ghost');
  expect(working).toContain('class="cw-card is-working"');
  // 干活时只让图标自己动:头像右下角原先有一颗小粉点(更早是一颗写着「干活中」的胶囊),主人都不要。
  // 连样式表里也不留它的规则。
  expect(working).not.toContain("cw-live");
  expect(working).not.toContain("干活中");
});

/** 一个数画出来的那几行字:没在动就只有它自己;在滚的话是滑出去的旧值和滑进来的新值。 */
const framesOf = (source: string, cls: string) =>
  [...source.matchAll(new RegExp(`class="${cls}( cw-out| cw-in)?"[^>]*>([^<]*)<`, "g"))].map((m) =>
    `${m[1] ?? ""} ${m[2]}`.trim(),
  );

test("a number that moved rolls: the old value slides out and the new one slides in, and nothing blinks", async ($, on) => {
  const use = await sessionAfter($, on, [36_400]);
  await begin($);
  expect(framesOf(await sourceOn($, { isWorking: true }), "cw-num g-c")).toEqual(["18%"]);

  use(60_000);
  await step($);
  const moved = await sourceOn($, { isWorking: true });
  expect(framesOf(moved, "cw-num g-c")).toEqual(["cw-out 18%", "cw-in 30%"]);
  expect(framesOf(moved, "cw-spent cw-sub")).toEqual(["cw-out +0", "cw-in +23.6k"]);
  // 滚的时候只动位置:真机上撞过,靠一帧一帧明灭来「数」的写法看上去是疯狂地闪。
  for (const name of ["cw-in-l", "cw-in-s"]) {
    expect(
      new RegExp(`@keyframes ${name}\\{(.*?\\})\\}`).exec(moved)?.[1] ?? "opacity",
    ).not.toContain("opacity");
  }
  expect(moved).not.toContain("cw-tick");
  // 滑出去的那一行落在裁切框外面,动画放完(或者被关掉)之后也看不见。
  expect(moved).toContain(".cw-out{opacity:0}");
  expect([
    ...moved.matchAll(/<g class="cw-roll-[ls]" clip-path="url\(#clip-(num|spent)\)">/g),
  ]).toHaveLength(2);
});

test("a request that moved nothing leaves the picture as it is: only the loops move on with the clock", async ($, on) => {
  const use = await sessionAfter($, on, [36_400]);
  await begin($);
  use(60_000);
  await step($);
  // 等数字滚完再比:滚的那一下只在读数刚落下时画。
  clock.now += 1_000;
  const before = await sourceOn($, { isWorking: true });

  // 又一次请求,窗口没动,只有时钟走了:除了循环动画的相位跟着钟往前走,图一个字都不变。
  clock.now += 4_000;
  await step($);
  const after = await sourceOn($, { isWorking: true });
  expect(unphased(after)).toBe(unphased(before));
  expect(after).not.toBe(before);
});

test("the turn completing where its last request left it brings the numbers to rest", async ($, on) => {
  const use = await sessionAfter($, on, [36_400]);
  await begin($);
  use(60_000);
  await step($);
  await $.turn.complete(TURN);

  const landed = await sourceOn($);
  expect(framesOf(landed, "cw-num g-c")).toEqual(["30%"]);
  expect(landed).not.toContain(' cw-out"');
});

test("the running bar grows from where it stood to where the turn has got to", async ($, on) => {
  const use = await sessionAfter($, on, [0, 36_400]);
  await begin($);
  use(54_600);
  await step($);
  // 这一轮先涨到 18.2k:答完的那一轮(36.4k)是 17 高,虚柱 9 高,从矮桩(3)长上来。
  const first = await sourceOn($, { isWorking: true });
  expect(ghostHeight(first)).toBe(9);
  expect(first).toContain("@keyframes cw-stretch{from{transform:scaleY(0.333)}");

  use(72_800);
  await step($);
  const second = await sourceOn($, { isWorking: true });
  expect(ghostHeight(second)).toBe(17);
  expect(second).toContain("@keyframes cw-stretch{from{transform:scaleY(0.529)}");

  // 答完时窗口没再动:柱子就停在那儿,不再长一遍。
  await $.turn.complete(TURN);
  expect(await sourceOn($)).not.toContain("@keyframes cw-stretch");
});

test("the storm strikes without flashing: nothing in it blinks", async ($, on) => {
  await sessionAfter($, on, [160_000]);

  const source = await sourceOn($, { isWorking: true });
  expect(source).toContain('class="cw-strike"');
  expect(source).toContain('class="cw-rumble"');
  expect(source).not.toContain("cw-flash");
  expect(source).not.toContain("cw-bolt");
  // 劈下来和云的抖动只动位置和大小,不动透明度。
  for (const name of ["cw-strike", "cw-rumble"]) {
    const frames = new RegExp(`@keyframes ${name}\\{(.*?\\})\\}`).exec(source)?.[1] ?? "opacity";
    expect(frames).not.toContain("opacity");
  }
});

test("a window almost full is a tornado", async ($, on) => {
  await sessionAfter($, on, [184_000]);

  const card = await cardOn($, { isWorking: true });
  expect(String(card?.props.alt).split(":")[0]).toBe("龙卷风");
  const source = String(card?.props.source);
  expect([...source.matchAll(/class="cw-funnel f\d"/g)]).toHaveLength(6);
  expect(source).toContain('class="cw-ring"');
  expect(source).not.toContain("cw-wobble");
  expect(source).not.toContain("lv-compact");
});

test("the tornado's ripple stays inside the image at its widest", async ($, on) => {
  await sessionAfter($, on, [184_000]);

  const source = String((await cardOn($, { isWorking: true }))?.props.source);
  const [left, top, width, height] = (/viewBox="([^"]+)"/.exec(source)?.[1] ?? "")
    .split(" ")
    .map(Number);
  // 头像的圆心,和从它那儿往外扩的那一圈。
  const [x, y, r] = (
    /<g transform="translate\((\d+) (\d+)\)"><circle class="cw-ring" r="(\d+)"/.exec(source) ?? []
  )
    .slice(1)
    .map(Number);
  const widest =
    r! * Number(/@keyframes cw-ripple\{.*?to\{transform:scale\(([\d.]+)\)/.exec(source)?.[1]);
  // 它得真的往外扩:缩成和头像一样大当然出不了界,可那就没有波纹了。
  expect(widest).toBeGreaterThan(r! + 6);
  // 图的边界会把出界的那一截切掉(原先左边被切掉 9 像素,上下各 1 像素):左、右、上、下都得留在图里。
  expect([
    x! - widest >= left!,
    x! + widest <= left! + width!,
    y! - widest >= top!,
    y! + widest <= top! + height!,
  ]).toEqual([true, true, true, true]);
});

test("the ambient loops keep their phase across redraws: they start from the clock, not from zero", async ($, on) => {
  await sessionAfter($, on, [36_400]);

  // 04:26:00 整,一小时里的第 1560 秒。
  const source = await sourceOn($, { isWorking: true });
  expect(source).toContain(".cw-card{--at:-1560000ms;--since:0ms}");
  expect(source).toContain(".is-working .cw-spin{animation:cw-spin 14s linear var(--at) infinite}");
});

test("a band drawn again with nothing new picks the loops up where they had got to: the phase follows the moment of drawing", async ($, on) => {
  // 真机上记日志看到的:宿主推来一次额度读数,带子重画了,而窗口读数和进度行都没变。
  // 相位要是按「最近一次变化的时刻」算,新摆上去的齿轮就从十秒前的角度转起,等于跳了一下。
  const use = await sessionAfter($, on, [36_400]);
  await begin($);
  use(60_000);
  await step($);
  await report($, { done: 3 });
  const [gauge, row] = await drawingsOn($);
  expect(gauge.source).toContain(".cw-card{--at:-1560000ms;");
  expect(row.source).toContain(".pr-row{--at:-1560000ms}");

  clock.now += 10_000;
  const [gaugeAgain, rowAgain] = await drawingsOn($);
  expect(gaugeAgain.source).toContain(".cw-card{--at:-1570000ms;");
  expect(rowAgain.source).toContain(".pr-row{--at:-1570000ms}");
});

test("a measurement that only moved the window leaves the quota gauges as they were", async ($, on) => {
  await sessionAfter($, on, [36_400], LIMITS);
  await $.session.measure({
    context: usageOf(40_000, []).context,
    rateLimits: [],
    changed: ["context"],
  });

  expect((await cardOn($))?.props.alt).toBe("晴朗:上下文 18%,36.4k / 200k;5 小时 23%;本周 29%");
});

test("the next turn starting does not replay what the last one brought in", async ($, on) => {
  await sessionAfter($, on, [36_400, 134_400]);
  expect(await sourceOn($)).toContain('class="cw-pop"');

  await begin($);
  const running = await sourceOn($, { isWorking: true });
  expect(running).not.toContain('class="cw-pop"');
  expect(running).not.toContain('cw-rise"');
  expect(running).not.toContain(' cw-out"');
});

test("a change of level brings the icon and the word in, mid-turn too", async ($, on) => {
  const use = await sessionAfter($, on, [36_400]);
  await begin($);
  use(134_400);
  await step($);

  const changed = await sourceOn($, { isWorking: true });
  expect(changed).toContain('class="cw-pop"');
  expect(changed).toContain('class="cw-ink cw-rise"');
});

test("a reading within the same level leaves the icon and the word where they are", async ($, on) => {
  await sessionAfter($, on, [36_400, 44_000]);

  const same = await sourceOn($);
  expect(same).not.toContain('class="cw-pop"');
  expect(same).not.toContain('class="cw-ink cw-rise"');
});

test("the two quota gauges stand beside the context gauge, each in the colour of its own level", async ($, on) => {
  await sessionAfter($, on, [36_400], LIMITS);

  const card = await cardOn($);
  expect(card?.props.alt).toBe("晴朗:上下文 18%,36.4k / 200k;5 小时 23%;本周 29%");
  const source = String(card?.props.source);
  for (const piece of [">5 小时<", ">23%<", ">还剩 2:14<", ">本周<", ">29%<", ">还剩 4 天<"]) {
    expect(source).toContain(piece);
  }
  expect([...source.matchAll(/class="cw-divider"/g)]).toHaveLength(2);
  // 23% 是晴朗那一档的暖橙,29% 是多云那一档的蓝。
  expect(source).toContain(
    '<linearGradient id="ava-h" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fdcb6e"/>',
  );
  expect(source).toContain(
    '<linearGradient id="ava-w" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#74b9ff"/>',
  );
});

test("without rate limits only the context gauge is drawn", async ($, on) => {
  await sessionAfter($, on, [36_400]);

  const source = await sourceOn($);
  expect(source).not.toContain("5 小时");
  expect(source).not.toContain("本周");
  expect(source).not.toContain('class="cw-divider"');
});

test("a spend limit, or a window the card does not know, is left out", async ($, on) => {
  await sessionAfter(
    $,
    on,
    [36_400],
    [
      { kind: "spend_limit", percentUsed: 41 },
      { kind: "thirty_day", percentUsed: 42 },
      { kind: "seven_day", percentUsed: 7 },
    ],
  );

  const card = await cardOn($);
  expect(card?.props.alt).toBe("晴朗:上下文 18%,36.4k / 200k;本周 7%");
  const source = String(card?.props.source);
  expect(source).not.toContain("41%");
  expect(source).not.toContain("42%");
  expect([...source.matchAll(/class="cw-divider"/g)]).toHaveLength(1);
});

test("a window with no reset time shows its percent without a countdown", async ($, on) => {
  await sessionAfter($, on, [36_400], [{ kind: "five_hour", percentUsed: 60 }]);

  const source = await sourceOn($);
  expect(source).toContain(">5 小时<");
  expect(source).toContain(">60%<");
  expect(source).not.toContain("还剩");
});

test("a reset already past reads as nothing left", async ($, on) => {
  await sessionAfter(
    $,
    on,
    [36_400],
    [{ kind: "five_hour", percentUsed: 99, resetsAt: "2026-10-04T04:00:00.000Z" }],
  );

  expect(await sourceOn($)).toContain(">还剩 0:00<");
});

// ---- 进度行:伦伦酱用「报进度」工具报上来的活,一件一行,排在仪表下面 ----

const PROGRESS = "mcp__context-band__progress";
const PHASES = [
  { name: "勘察", steps: 2, survey: true },
  { name: "施工", steps: 5 },
  { name: "门禁", steps: 2 },
];

/** 伦伦酱报一次进度;回的是它读到的那句回执。 */
const report = async ($: Engine, input: Record<string, unknown>) => {
  const answer = await $.tool.call({
    tool: PROGRESS,
    plan: "slice-20",
    title: "切片 ⑳ · 图库合并",
    phases: PHASES,
    ...input,
  } as never);
  return String((answer as { result?: unknown }).result);
};

/** 带里的每一张图,按画的先后,从上到下。 */
const stackOn = async ($: Engine) => {
  const ui = await $.ui.mount({ ...BAND, surface: "desktop" });
  const svgs = await ui.findAll({ type: "Svg" });
  await ui.unmount();
  return svgs.map((svg) => ({
    alt: String(svg.props.alt),
    source: String(svg.props.source),
    height: svg.props.height,
    isInteractive: svg.props.isInteractive,
  }));
};

/** 带里的每一张图,仪表排第一、后面一行一张(画的时候仪表在最下面,这里挪到前面好取)。 */
const drawingsOn = async ($: Engine) => {
  const stack = await stackOn($);
  return [stack[stack.length - 1], ...stack.slice(0, -1)];
};

/** 图里循环动画的相位(从哪一毫秒起步)抹掉之后的样子:比「别的都没变」时用。 */
const unphased = (source: string) => source.replace(/--at:-\d+ms/, "--at:*");

test("a reported piece of work is a row under the gauges, and the report is acknowledged in a line", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  expect(await report($, { done: 3 })).toBe(
    "记下了:切片 ⑳ · 图库合并,施工 1.1/3,一共 3/9。带里现在 1 行。",
  );

  const [gauges, row, ...rest] = await drawingsOn($);
  expect(rest).toEqual([]);
  expect(gauges.alt).toBe("晴朗:上下文 18%,36.4k / 200k");
  expect(row.alt).toBe("切片 ⑳ · 图库合并:工作中,施工 1.1/3,33%");
  expect(row.height).toBe(28);
  expect(row.isInteractive).toBeUndefined();
  for (const piece of [
    ">切片 ⑳ · 图库合并<",
    '><tspan class="pr-now">施工</tspan><',
    'fill="#18191C">1<tspan class="pr-of"',
    ">/3</tspan></text>",
    'viewBox="-8 0 696 28"',
  ]) {
    expect(row.source).toContain(piece);
  }
});

for (const [name, input, alt, kind] of [
  ["the survey phase", { done: 1 }, "切片 ⑳ · 图库合并:勘察阶段,勘察 0.1/3,11%", "survey"],
  ["work under way", { done: 4 }, "切片 ⑳ · 图库合并:工作中,施工 1.2/3,44%", "working"],
  [
    "waiting for a decision",
    { done: 6, status: "decide" },
    "切片 ⑳ · 图库合并:等你拍板,施工 1.4/3,67%",
    "decide",
  ],
  ["all done", { done: 9 }, "切片 ⑳ · 图库合并:做完了,完成 3/3,100%", "done"],
] as const) {
  test(`${name} has its own icon and colour`, async ($, on) => {
    await sessionAfter($, on, [36_400]);
    await report($, input);

    const [, row] = await drawingsOn($);
    expect(row.alt).toBe(alt);
    expect(row.source).toContain(`class="pr-row k-${kind}`);
    expect([...row.source.matchAll(/class="pr-icon i-([a-z]+)"/g)].map((m) => m[1])).toEqual([
      kind,
    ]);
  });
}

test("waiting for a decision has to be said each time: the next plain report goes back to what the steps say", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await report($, { done: 6, status: "decide" });
  await report($, { done: 6 });

  expect((await drawingsOn($))[1].alt).toBe("切片 ⑳ · 图库合并:工作中,施工 1.4/3,67%");
});

test("a report that moved the work slides the bar and the pill from where they stood; the same report again leaves the picture as it is", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await report($, { done: 3 });
  const first = (await drawingsOn($))[1].source;
  // 轨道 432 宽:3/9 是 144,6/9 是 288。第一次报,从 0 长出来。
  expect(first).toContain(
    "@keyframes pr-fill{from{transform:translateX(-432px)}to{transform:translateX(-288px)}}",
  );

  // 过了 5 秒早就滑完了:再画就是停在位置上的样子。同一份报告再来一次,图不变,也不再滑。
  clock.now += 5_000;
  const settled = (await drawingsOn($))[1].source;
  expect(settled).not.toContain("@keyframes pr-fill");
  await report($, { done: 3 });
  expect((await drawingsOn($))[1].source).toBe(settled);

  await report($, { done: 6 });
  const moved = (await drawingsOn($))[1].source;
  expect(moved).toContain(
    "@keyframes pr-fill{from{transform:translateX(-288px)}to{transform:translateX(-144px)}}",
  );
  expect(moved).toContain("@keyframes pr-pill{from{transform:translateX(");
});

test("while the bar slides the marked step waits: it fades in as the pill lands, not ahead of it", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await report($, { done: 3 });
  await report($, { done: 4 });

  // 进度头挪了,胶囊和填充要滑 0.45 秒才到。正在做的那一格(淡底和小箭头)要是立刻出现在新位置,
  // 就孤零零悬在前面、和胶囊之间隔着一段空轨道(把片子一帧帧截下来才看见的)。等胶囊快到了它再淡进来。
  const moved = (await drawingsOn($))[1].source;
  expect(moved).toContain("@keyframes pr-doing{from{opacity:0}to{opacity:1}}");
  expect(moved).toContain(
    ".pr-doing{animation:pr-doing .2s ease-out calc(var(--since) + .3s) both}",
  );
});

test("reporting progress leaves the gauges exactly as they were", async ($, on) => {
  await sessionAfter($, on, [36_400], LIMITS);
  const before = (await drawingsOn($))[0].source;
  clock.now += 5_000;
  await report($, { done: 3 });

  // 相位跟着最新的时刻走(图被重新摆上去时动画才接得上),别的一个字不变。
  expect(unphased((await drawingsOn($))[0].source)).toBe(unphased(before));
});

/** 带里的行,从上到下各叫什么(最下面的仪表不算)。 */
const titlesOn = async ($: Engine) =>
  (await stackOn($)).slice(0, -1).map((row) => row.alt.split(":")[0]);

test("every piece of work shows; the first one reported sits at the bottom and later ones stack above it", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  for (const plan of ["总", "期", "片", "小片"]) {
    await report($, { plan, title: `活 ${plan}`, done: 1 });
  }
  // 再报一次不挪位置。
  await report($, { plan: "期", title: "活 期", done: 2 });

  expect(await titlesOn($)).toEqual(["活 小片", "活 片", "活 期", "活 总"]);
});

test("ten pieces of work are remembered; an eleventh pushes out the one reported longest ago", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  for (let i = 0; i < 11; i++) {
    clock.now = NOW + i;
    await report($, { plan: `p${i}`, title: `活 ${i}`, done: 1 });
  }

  const titles = await titlesOn($);
  expect(titles).toHaveLength(10);
  expect(titles).not.toContain("活 0");
  expect(titles[0]).toBe("活 10");
});

test("a row waiting for a decision goes back to work when the user sends a prompt, not when a turn merely starts", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await report($, { done: 3, status: "decide" });
  // 后台的活回来也会开一轮:主人没说话,还在等。
  await begin($);
  await $.turn.complete(TURN);
  expect((await stackOn($))[0].alt).toContain("等你拍板");

  await $.prompt.submit({ text: "就这样" } as never);
  expect((await stackOn($))[0].alt).toContain("工作中");
});

test("the pill counts what is done out of the whole piece of work: work just begun reads 0, never 1", async ($, on) => {
  // 原先写的是「正在做第几步」,开工时就是 1/4,旁边的百分比却是 0% —— 看着像做完了一步(主人指出来的)。
  await sessionAfter($, on, [36_400]);
  const one = { name: "期", steps: 1 };
  // 好几个阶段、每个一步:做完几个 / 一共几个。前面的名字是正在做的那个阶段。
  expect(
    await report($, {
      plan: "a",
      title: "总",
      phases: [{ name: "1期", steps: 1 }, one, one, one],
      done: 0,
    }),
  ).toContain("1期 0/4,");
  expect(
    await report($, {
      plan: "a",
      title: "总",
      phases: [one, { name: "2期", steps: 1 }, one, one],
      done: 1,
    }),
  ).toContain("2期 1/4,");
  // 只有一个阶段:做完几步 / 一共几步。
  expect(
    await report($, { plan: "b", title: "期", phases: [{ name: "切片", steps: 18 }], done: 0 }),
  ).toContain("切片 0/18,");
  expect(
    await report($, { plan: "b", title: "期", phases: [{ name: "切片", steps: 18 }], done: 9 }),
  ).toContain("切片 9/18,");
  // 眼下这个阶段还分步:做完几个阶段.眼下这个阶段做完几步 / 一共几个阶段。
  expect(await report($, { plan: "c", title: "片", done: 0 })).toContain("勘察 0.0/3,");
  expect(await report($, { plan: "c", title: "片", done: 4 })).toContain("施工 1.2/3,");
  // 前两个阶段刚做满、最后一个还没动:是 2.0,不是看着像全做完了的 3.0。
  expect(await report($, { plan: "c", title: "片", done: 7 })).toContain("门禁 2.0/3,");
  expect(
    await report($, { plan: "b", title: "期", phases: [{ name: "切片", steps: 18 }], done: 18 }),
  ).toContain("完成 18/18,");
  expect(await report($, { plan: "c", title: "片", done: 9 })).toContain("完成 3/3,");
});

test("the pill carries the decimal only while the phase in hand has steps of its own", async ($, on) => {
  // 原先只要有一个阶段分步,所有阶段都带小数:只有一步的阶段成了「首个提交 3.0/4」,那个 .0 什么也没说(主人指出来的)。
  await sessionAfter($, on, [36_400]);
  const phases = [
    { name: "建仓", steps: 1 },
    { name: "文档", steps: 2 },
    { name: "门禁", steps: 1 },
    { name: "首个提交", steps: 1 },
  ];
  const at = (done: number) => report($, { plan: "m", title: "混", phases, done });
  expect(await at(0)).toContain("建仓 0/4,");
  // 分步的阶段刚开始也带小数:.0 说的是「这一段里还有几步,一步没做」。
  expect(await at(1)).toContain("文档 1.0/4,");
  expect(await at(2)).toContain("文档 1.1/4,");
  expect(await at(3)).toContain("门禁 2/4,");
  expect(await at(4)).toContain("首个提交 3/4,");
  expect(await at(5)).toContain("完成 4/4,");
});

const spawn = ($: Engine, description = "勘察 ⑳") =>
  $.agent.spawn({
    description,
    prompt: "p",
    subagentType: "sonnet-xhigh",
    background: true,
  } as never);

test("every image in the band is equally wide and leaves the same margin on both sides of what it draws", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await report($, { done: 3 });
  await spawn($);

  const frames = (await stackOn($)).map((one) =>
    (/viewBox="(\S+) 0 (\S+) \d+" width="(\S+)"/.exec(one.source) ?? []).slice(1).map(Number),
  );
  // 子代理行、进度行、仪表各一张。内容都画在 0 到 680 之间,图两边各多出 8 像素:
  // 宿主把每张图居中摆,两边一样宽内容才还在原处;三张一样宽,窗口窄到要缩小时才缩得一样多、上下对得齐。
  expect(frames).toEqual([
    [-8, 696, 696],
    [-8, 696, 696],
    [-8, 696, 696],
  ]);
});

test("a subagent gets a row of its own above the reported rows, counting its model requests while the main loop is idle", async ($, on) => {
  const use = await sessionAfter($, on, [36_400]);
  await report($, { done: 3 });
  await spawn($);
  expect(await titlesOn($)).toEqual(["勘察 ⑳", "切片 ⑳ · 图库合并"]);
  expect((await stackOn($))[0].alt).toBe("勘察 ⑳:子代理在跑,0 个工具轮");

  clock.now = NOW + 3 * 60_000;
  use(90_000);
  await step($, { agentId: "agent-1" });
  await step($, { agentId: "agent-1" });

  const [agent, , gauges] = await stackOn($);
  expect(agent.alt).toBe("勘察 ⑳:子代理在跑,2 个工具轮");
  // 主循环闲着,它自己照样动。
  expect(agent.source).toContain('class="pr-row k-agent is-working"');
  expect(agent.source).toContain(">3 分<");
  // 子代理跑在自己的窗口里,仪表不跟着走。
  expect(gauges.alt).toBe("晴朗:上下文 18%,36.4k / 200k");
});

test("a finished subagent shows as done through the turn that hears of it and is gone when that turn ends", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await spawn($);
  await step($, { agentId: "agent-1" });
  await $.turn.complete({ ...TURN, agentId: "agent-1" } as never);
  expect((await stackOn($))[0].alt).toBe("勘察 ⑳:子代理做完了,1 个工具轮");
  expect((await stackOn($))[0].source).toContain('class="pr-row k-agent"');

  // 它的回报开出来的那一轮:还在。
  await begin($);
  expect(await titlesOn($)).toEqual(["勘察 ⑳"]);
  await $.turn.complete(TURN);
  expect(await titlesOn($)).toEqual([]);
});

test("a subagent still running when the main turn ends keeps its row", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await begin($);
  await spawn($);
  await $.turn.complete(TURN);
  expect(await titlesOn($)).toEqual(["勘察 ⑳"]);
});

test("a subagent that was interrupted shows as stopped, and one sent back to work shows as running again", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await spawn($);
  await $.turn.complete({
    ...TURN,
    agentId: "agent-1",
    isAborted: true,
    reason: "aborted",
  } as never);
  expect((await stackOn($))[0].alt).toBe("勘察 ⑳:子代理停了,0 个工具轮");

  await step($, { agentId: "agent-1", turnId: "t2" });
  expect((await stackOn($))[0].alt).toBe("勘察 ⑳:子代理在跑,1 个工具轮");
});

test("the last request of a subagent landing after its turn has ended does not bring the row back to running", async ($, on) => {
  // 真机上撞过:跑完的子代理一直留在带里。最后一次请求的收尾和这一轮的收场谁先写状态不一定。
  await sessionAfter($, on, [36_400]);
  await spawn($);
  await $.turn.complete({ ...TURN, agentId: "agent-1" } as never);
  await step($, { agentId: "agent-1" });
  expect((await stackOn($))[0].alt).toBe("勘察 ⑳:子代理做完了,1 个工具轮");

  await begin($);
  expect(await titlesOn($)).toEqual(["勘察 ⑳"]);
  await $.turn.complete(TURN);
  expect(await titlesOn($)).toEqual([]);
});

test("requests from a subagent nobody saw start (spawned before a reload) still get a row", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await step($, { agentId: "agent-9" });

  expect((await stackOn($))[0].alt).toBe("子代理:子代理在跑,1 个工具轮");
});

test("two subagents each keep their own row, the later one on top", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await spawn($, "服务端");
  spawned.id = "agent-2";
  clock.now = NOW + 1;
  await spawn($, "面板");
  spawned.id = "agent-1";

  expect(await titlesOn($)).toEqual(["面板", "服务端"]);
});

test("a finished row stays for the turn it finished in and is gone when the next one starts", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await begin($);
  await report($, { done: 9 });
  await report($, {
    plan: "mods",
    title: "桌面 mods",
    phases: [{ name: "任务", steps: 5 }],
    done: 2,
  });
  await $.turn.complete(TURN);
  expect(await drawingsOn($)).toHaveLength(3);

  await begin($);
  expect((await drawingsOn($)).slice(1).map((row) => row.alt.split(":")[0])).toEqual(["桌面 mods"]);
});

test("a row can be taken off by asking", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await report($, { done: 3 });
  expect(await report($, { done: 3, remove: true })).toBe(
    "撤掉了:切片 ⑳ · 图库合并。带里现在 0 行。",
  );

  expect(await drawingsOn($)).toHaveLength(1);
});

for (const [name, input, why] of [
  ["no phases", { phases: [], done: 0 }, "phases 至少要有一个阶段"],
  [
    "a phase with no steps",
    { phases: [{ name: "施工", steps: 0 }], done: 0 },
    "每个阶段的 steps 要是正整数",
  ],
  ["a count that is not a number", { done: "三" }, "done 要是不小于 0 的整数"],
  ["no title", { title: "" }, "plan 和 title 都要有"],
] as const) {
  test(`a report with ${name} is turned down with the reason, and draws nothing`, async ($, on) => {
    await sessionAfter($, on, [36_400]);
    expect(await report($, { done: 1, ...input })).toBe(`没记上:${why}。`);
    expect(await drawingsOn($)).toHaveLength(1);
  });
}

test("steps reported past the end count as all done", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await report($, { done: 12 });

  expect((await drawingsOn($))[1].alt).toBe("切片 ⑳ · 图库合并:做完了,完成 3/3,100%");
});

test("the rows move only while a turn runs", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await report($, { done: 4 });
  expect((await drawingsOn($))[1].source).toContain('class="pr-row k-working"');

  await begin($);
  expect((await drawingsOn($))[1].source).toContain('class="pr-row k-working is-working"');
});

test("the terminal band lists the rows under the forecast line", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await report($, { done: 4 });

  const ui = await $.ui.mount({ ...BAND, surface: "terminal" });
  expect(await ui.find({ type: "Text", text: /切片 ⑳ · 图库合并/ })).toBeDefined();
  expect(await ui.find({ type: "Text", text: /施工 1\.2\/3/ })).toBeDefined();
  expect(await ui.find({ type: "Text", text: /44%/ })).toBeDefined();
  await ui.unmount();
});

test("a report that lands while the card is reading the window is not lost", async ($, on) => {
  // 真机上撞过:行闪了几下就没了。读用量要等宿主作答,报进度正好落在这段等待里;
  // 读完之后要是拿等待之前的那份数据整个写回去,刚记上的行就被盖掉了。
  const use = await sessionAfter($, on, [36_400]);
  await begin($);
  use(60_000);
  let landed = false;
  reads.onRead = async () => {
    if (landed) return;
    landed = true;
    await report($, { done: 3 });
  };
  await step($);

  const drawings = await drawingsOn($);
  expect(drawings.map((drawing) => drawing.alt.split(":")[0])).toEqual([
    "多云",
    "切片 ⑳ · 图库合并",
  ]);
});

test("two reports sent at once both land", async ($, on) => {
  // 伦伦酱一条消息里可以同时报两件活:两次调用是并着跑的,谁都不能把另一个盖掉。
  await sessionAfter($, on, [36_400]);
  const answers = await Promise.all([
    report($, { plan: "a", title: "活 a", done: 1 }),
    report($, { plan: "b", title: "活 b", done: 2 }),
  ]);
  expect(answers[1]).toBe(
    "记下了:活 b,勘察 2/2 之后的施工 1.0/3,一共 2/9。带里现在 2 行。".replace(
      "勘察 2/2 之后的",
      "",
    ),
  );

  expect((await drawingsOn($)).slice(1).map((row) => row.alt.split(":")[0])).toEqual([
    "活 b",
    "活 a",
  ]);
});

test("the step being worked on is marked: a tinted stretch from the head of the bar to the next tick", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await report($, { done: 4 });

  // 轨道从 188 起、432 宽,一共 9 步:做完 4 步,头在 192;正在做的第 5 步是 192 到 240 这一格。
  // 胶囊的右端是圆的,这一格要往胶囊底下多伸进去半个圆角(9),不然圆角外面露两个缺口(真机上撞过)。
  const { source } = (await drawingsOn($))[1];
  expect(source).toContain(
    '<clipPath id="pr-next"><rect x="371" y="5" width="57" height="18"/></clipPath>',
  );
  expect(source).toContain('<g class="pr-doing" clip-path="url(#pr-next)">');
  // 胶囊画在它后面,盖在上面。
  expect(source.indexOf('class="pr-doing"')).toBeLessThan(source.indexOf('class="pr-pill"'));
});

test("small arrows walk from the pill to the next tick: the name on the pill is where the work is heading", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await report($, { done: 4 });

  // 胶囊写的是正在做的阶段,人却趴在做完的那一段上(主人指出来的):箭头从它走向下一道刻度,说的是「从这儿干到那儿」。
  // 胶囊右端在 380,这一格还剩 48。箭头从胶囊底下钻出来(比停着的位置靠左 8),一直走到下一道刻度,正好走 48:
  // 整格都是它的路,前后尽量隔 13.5,这里四只(隔 12)。每秒走 24,所以这一趟是 2 秒;两头各用 7 淡入淡出。
  const { source } = (await drawingsOn($))[1];
  expect([
    ...source.matchAll(/<path class="pr-walk[^"]*" d="M385,10 l4,4 l-4,4"\/>/g),
  ]).toHaveLength(4);
  expect(source).toContain(
    "@keyframes pr-walk{0%{transform:translateX(-8px);opacity:0}14.583%{opacity:1}85.417%{opacity:1}100%{transform:translateX(40px);opacity:0}}",
  );
  // 四只把一趟平分着错开走,前后差半秒;回合停了就不走,叠成胶囊右边的一只,停着也指着方向。
  expect(source).toContain(".is-working .pr-walk{animation:pr-walk 2s linear var(--at) infinite}");
  expect(source).toContain(".is-working .pr-walk.d1{animation-delay:calc(var(--at) + .5s)}");
  expect(source).toContain(".is-working .pr-walk.d2{animation-delay:calc(var(--at) + 1s)}");
  expect(source).toContain(".is-working .pr-walk.d3{animation-delay:calc(var(--at) + 1.5s)}");
  // 有箭头的这一格不再铺流动的斜纹:斜纹只剩填充上那一层。
  expect([...source.matchAll(/class="pr-stripes"/g)]).toHaveLength(1);
});

test("the pill names the phase under way and its name pulses; the count stands at the end of the row, where the percentage was", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await report($, {
    plan: "big",
    title: "大改造",
    phases: ["1期", "2期", "3期", "4期", "5期", "6期", "7期"].map((name) => ({ name, steps: 1 })),
    done: 1,
  });

  // 原先胶囊写「2期 1/7」,人却趴在做完的第 1 期上(主人指出来的)。现在只写正在做的那一期,
  // 字一明一暗说它还没做完,回合在跑才动;数字挪到行尾,百分比不要了(主人定的)。
  const { source } = (await drawingsOn($))[1];
  expect(source).toContain(
    'font-weight="700" fill="#fff"><tspan class="pr-now">2期</tspan></text>',
  );
  expect(source).toContain(
    'text-anchor="end" font-size="14" font-weight="700" fill="#18191C">1<tspan class="pr-of"',
  );
  expect(source).toContain(">/7</tspan></text>");
  // 每一期只有一步:没有「这一期走到一半」可画,行尾不带那个小环。
  expect(source).not.toContain('class="pr-steps"');
  expect(source).not.toContain("%</text>");
  expect(source).toContain(
    ".is-working .pr-now{animation:pr-now 1.4s ease-in-out var(--at) infinite alternate}",
  );
});

test("a single phase reads the same way: its name on the pill, the steps at the end of the row", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await report($, { plan: "one", title: "一件活", phases: [{ name: "切片", steps: 18 }], done: 9 });

  const { source } = (await drawingsOn($))[1];
  expect(source).toContain('fill="#fff"><tspan class="pr-now">切片</tspan></text>');
  expect(source).toContain('fill="#18191C">9<tspan class="pr-of"');
  expect(source).toContain(">/18</tspan></text>");
  // 只有一个阶段:分数说的已经是步数,再画一个环就是把同一件事说两遍。
  expect(source).not.toContain('class="pr-steps"');
});

test("the end of a row says two different things: the fraction counts phases, the small ring counts the steps of the phase under way", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  // 勘察 2 步、施工 5 步、门禁 2 步。做完 3 步:勘察做完了,施工做了 5 步里的 1 步。
  await report($, { done: 3 });
  const first = (await drawingsOn($))[1].source;
  // 原先这两样拼成一个带小数点的数「1.1/3」,主人说看着怪:现在分数只说做完 1 个阶段、共 3 个,分子大、分母小。
  expect(first).toContain(
    '<text class="pr-ink" x="680" y="18.5" text-anchor="end" font-size="14" font-weight="700" fill="#18191C">1<tspan class="pr-of" dx="1" font-size="10.5" font-weight="600" fill="#666">/3</tspan></text>',
  );
  expect(first).not.toContain("1.1/3");
  // 小环在分数左边,按施工的 5 步切成 5 段(每段 14.8、空 5.2,一圈按 100 算),亮着 1 段。
  expect(first).toContain('<g class="pr-steps" transform="translate(647.5 14) rotate(-90)"');
  expect(first).toContain('stroke-dasharray="14.8 5.2"/>');
  expect(first).toContain('stroke="#e84393" stroke-dasharray="14.8 100"/>');

  await report($, { done: 4 });
  expect((await drawingsOn($))[1].source).toContain('stroke-dasharray="14.8 5.2 14.8 100"/>');

  // 环的颜色跟着这一行的状态走:等拍板是橙的。
  await report($, { done: 4, status: "decide" });
  expect((await drawingsOn($))[1].source).toContain(
    'stroke="#e17055" stroke-dasharray="14.8 5.2 14.8 100"/>',
  );

  // 做完了:没有正在做的阶段,不画环。
  await report($, { done: 9 });
  const finished = (await drawingsOn($))[1].source;
  expect(finished).toContain('fill="#18191C">3<tspan class="pr-of"');
  expect(finished).not.toContain('class="pr-steps"');
});

test("a phase of more than eight steps cannot be cut into readable pieces: its ring is one arc", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await report($, {
    plan: "long",
    title: "迁移",
    phases: [
      { name: "准备", steps: 1 },
      { name: "回填", steps: 12 },
    ],
    done: 6,
  });
  const { source } = (await drawingsOn($))[1];
  // 回填做了 12 步里的 5 步:一整圈的底,亮着十二分之五。
  expect(source).toContain(
    '<circle class="pr-steps-all" r="6.5" pathLength="100" stroke="#000" stroke-opacity="0.13"/>',
  );
  expect(source).toContain('stroke-dasharray="41.667 100"/>');
});

for (const [name, input, text] of [
  ["waiting for a decision", { done: 6, status: "decide" }, "施工"],
  ["all done", { done: 9 }, "完成"],
] as const) {
  test(`${name}, nothing is under way: no word on the pill blinks`, async ($, on) => {
    await sessionAfter($, on, [36_400]);
    await report($, input);

    const { source } = (await drawingsOn($))[1];
    expect(source).toContain(`>${text}</text>`);
    expect(source).not.toContain('class="pr-now"');
  });
}

test("several phases of one step each: the arrows run through the phase the pill names", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await report($, {
    plan: "big",
    title: "大改造",
    phases: ["1期", "2期", "3期", "4期", "5期", "6期", "7期"].map((name) => ({ name, steps: 1 })),
    done: 1,
  });

  // 一期 62 宽:做完 1 期,头在 62,胶囊「2期」右端贴着它;箭头停在 255,走起来一直走到第 2 期的右沿。
  const { source } = (await drawingsOn($))[1];
  expect(source).toContain('d="M255,10 l4,4 l-4,4"');
  expect(source).toContain("100%{transform:translateX(53px);opacity:0}");
});

test("a wide step is walked at the same pace and as densely as a narrow one: it just holds more arrows", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await report($, {
    plan: "big",
    title: "大改造",
    phases: ["1期", "2期", "3期"].map((name) => ({ name, steps: 1 })),
    done: 1,
  });

  // 一期 144 宽:前后尽量隔 13.5(主人说 8 步那行 54 宽里四只的密度正好),最接近的是十一只;
  // 每秒走 24(12 步那行的速度),一趟 6 秒。
  // (一趟的时间定死、只数封顶的话,宽格子里又快又稀,窄格子里又慢,主人看过。)
  const { source } = (await drawingsOn($))[1];
  expect([
    ...source.matchAll(/<path class="pr-walk[^"]*" d="M337,10 l4,4 l-4,4"\/>/g),
  ]).toHaveLength(11);
  expect(source).toContain(".is-working .pr-walk{animation:pr-walk 6s linear var(--at) infinite}");
  expect(source).toContain(".is-working .pr-walk.d1{animation-delay:calc(var(--at) + .545s)}");
  expect(source).toContain(".is-working .pr-walk.d10{animation-delay:calc(var(--at) + 5.455s)}");
  // 淡入淡出的长度不跟着格子变长:还是两头各 7。
  expect(source).toContain("4.861%{opacity:1}95.139%{opacity:1}");
});

test("a narrow step gets two arrows, a whole 12 apart: with only half the cell to walk they sat 6 apart and looked crammed", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await report($, {
    plan: "slices",
    title: "第 2 期",
    phases: [{ name: "切片", steps: 18 }],
    done: 14,
  });

  // 一步 24 宽(主人截图里那一行):三只挤成一团,只走半格的两只也嫌挤(都是主人看过的)。整格都走,放得下两只。
  const { source } = (await drawingsOn($))[1];
  expect([
    ...source.matchAll(/<path class="pr-walk[^"]*" d="M529,10 l4,4 l-4,4"\/>/g),
  ]).toHaveLength(2);
  expect(source).toContain("100%{transform:translateX(16px);opacity:0}");
  expect(source).toContain(".is-working .pr-walk{animation:pr-walk 1s linear var(--at) infinite}");
  expect(source).toContain(".is-working .pr-walk.d1{animation-delay:calc(var(--at) + .5s)}");
  expect(source).not.toContain(".pr-walk.d2");
});

test("a middling step gets three arrows", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await report($, {
    plan: "slices",
    title: "第 2 期",
    phases: [{ name: "切片", steps: 12 }],
    done: 6,
  });

  // 一步 36 宽:三只,前后隔 12,一趟 1.5 秒。主人说这一种的密度和速度正好,别的宽度都照它来。
  const { source } = (await drawingsOn($))[1];
  expect([
    ...source.matchAll(/<path class="pr-walk[^"]*" d="M409,10 l4,4 l-4,4"\/>/g),
  ]).toHaveLength(3);
  expect(source).toContain("100%{transform:translateX(28px);opacity:0}");
  expect(source).toContain(
    ".is-working .pr-walk{animation:pr-walk 1.5s linear var(--at) infinite}",
  );
  expect(source).toContain("19.444%{opacity:1}80.556%{opacity:1}");
  expect(source).toContain(".is-working .pr-walk.d1{animation-delay:calc(var(--at) + .5s)}");
  expect(source).toContain(".is-working .pr-walk.d2{animation-delay:calc(var(--at) + 1s)}");
  expect(source).not.toContain(".pr-walk.d3");
});

test("a step of 33 gets two arrows, not three 11 apart", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await report($, {
    plan: "promo",
    title: "宣传视频",
    phases: [
      { name: "分镜", steps: 1 },
      { name: "搭建", steps: 2 },
      { name: "配色", steps: 1 },
      { name: "声音", steps: 8 },
      { name: "成片", steps: 1 },
    ],
    done: 12,
  });

  // 一共 13 步,一步 33 宽(主人带上那一行):两只隔 16.5,三只隔 11。两种主人都在带上看过,说两只的最合适。
  const { source } = (await drawingsOn($))[1];
  expect([
    ...source.matchAll(/<path class="pr-walk[^"]*" d="M592,10 l4,4 l-4,4"\/>/g),
  ]).toHaveLength(2);
  expect(source).toContain("100%{transform:translateX(25px);opacity:0}");
  expect(source).toContain(
    ".is-working .pr-walk{animation:pr-walk 1.375s linear var(--at) infinite}",
  );
});

test("a wide step gets six arrows a little over 14 apart, not seven", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await report($, {
    plan: "slices",
    title: "大格 5 步",
    phases: [{ name: "切片", steps: 5 }],
    done: 2,
  });

  // 一步 86 宽:按隔 13.5 算最接近的是六只(隔 14.3),不是七只(主人看过这一行,说标准)。
  const { source } = (await drawingsOn($))[1];
  expect([
    ...source.matchAll(/<path class="pr-walk[^"]*" d="M366,10 l4,4 l-4,4"\/>/g),
  ]).toHaveLength(6);
});

test("arrows never sit closer than 12: a step that would hold two only by squeezing them gets one", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await report($, {
    plan: "slices",
    title: "第 2 期",
    phases: [{ name: "切片", steps: 20 }],
    done: 10,
  });

  // 一步 22 宽:按隔 13.5 算最接近的是两只,可那样前后只隔 11。不比 12 更密,所以一只(主人说的:二十步往上才一只)。
  const { source } = (await drawingsOn($))[1];
  expect([
    ...source.matchAll(/<path class="pr-walk[^"]*" d="M409,10 l4,4 l-4,4"\/>/g),
  ]).toHaveLength(1);
  expect(source).not.toContain(".pr-walk.d1");
});

test("a tiny step gets a single arrow", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await report($, {
    plan: "slices",
    title: "第 2 期",
    phases: [{ name: "切片", steps: 24 }],
    done: 12,
  });

  // 一步 18 宽(二十步往上的行):只放得下一只。
  const { source } = (await drawingsOn($))[1];
  expect([
    ...source.matchAll(/<path class="pr-walk[^"]*" d="M409,10 l4,4 l-4,4"\/>/g),
  ]).toHaveLength(1);
  expect(source).toContain("100%{transform:translateX(10px);opacity:0}");
  // 路短,一趟就短:.75 秒;淡入淡出最多各占一趟的两成。
  expect(source).toContain(
    ".is-working .pr-walk{animation:pr-walk .75s linear var(--at) infinite}",
  );
  expect(source).toContain("20%{opacity:1}80%{opacity:1}");
  expect(source).not.toContain(".pr-walk.d1");
});

test("a step with no room for even one arrow keeps the flowing stripes", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await report($, {
    plan: "many",
    title: "很多步",
    phases: [{ name: "切片", steps: 40 }],
    done: 20,
  });

  // 一步 11 宽,不到 12:箭头走不开,这一格照旧铺流动的斜纹(填充上一层,这一格一层)。
  const { source } = (await drawingsOn($))[1];
  expect(source).toContain('class="pr-doing"');
  expect(source).not.toContain('class="pr-walk');
  expect([...source.matchAll(/class="pr-stripes"/g)]).toHaveLength(2);
});

test("at the very start the pill is pushed against the left end: the marked step begins where the pill ends, not where the bar does", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await report($, {
    plan: "mods",
    title: "桌面 mods",
    phases: [{ name: "任务", steps: 8 }],
    done: 0,
  });

  // 一步 54 宽。胶囊「任务」38 宽,顶在最左:这一格从胶囊右端往里 9 起,到第一道刻度。
  const { source } = (await drawingsOn($))[1];
  expect(source).toContain(
    '<clipPath id="pr-next"><rect x="217" y="5" width="25" height="18"/></clipPath>',
  );
  // 胶囊右边只剩 16:放得下一只箭头。
  expect([...source.matchAll(/class="pr-walk/g)]).toHaveLength(1);
  expect([...source.matchAll(/class="pr-stripes"/g)]).toHaveLength(1);
});

test("a step narrower than the pill sitting on it has no room to be marked", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await report($, {
    plan: "many",
    title: "很多步",
    phases: [{ name: "任务", steps: 40 }],
    done: 0,
  });

  expect((await drawingsOn($))[1].source).not.toContain('class="pr-doing"');
});

test("the stripes never spill past what they mark", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await report($, { done: 4 });

  // 真机上撞过:填充上的斜纹流动时往右多冲出去一截,露在胶囊右边,一直在动。
  // 斜纹各自关在裁切框里:填充上的不出填充,正在做的那一格的不出那一格。
  const { source } = (await drawingsOn($))[1];
  expect([
    ...source.matchAll(/<g clip-path="url\(#pr-done\)"><rect class="pr-stripes"/g),
  ]).toHaveLength(1);
  expect(source).toContain('<clipPath id="pr-done"><rect width="432" height="18"/></clipPath>');
});

for (const [name, input] of [
  ["waiting for a decision", { done: 6, status: "decide" }],
  ["all done", { done: 9 }],
] as const) {
  test(`${name}, nothing is being worked on: no marked step`, async ($, on) => {
    await sessionAfter($, on, [36_400]);
    await report($, input);

    expect((await drawingsOn($))[1].source).not.toContain('class="pr-doing"');
  });
}

test("the rows sit above the gauges: the gauges stay at the bottom and the rows grow upward", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await report($, { plan: "a", title: "活 a", done: 1 });
  await report($, { plan: "b", title: "活 b", done: 2 });

  expect((await stackOn($)).map((drawing) => drawing.alt.split(":")[0])).toEqual([
    "活 b",
    "活 a",
    "晴朗",
  ]);

  const ui = await $.ui.mount({ ...BAND, surface: "terminal" });
  const lines = (await ui.findAll({ type: "Text" }))
    .map((text) => String(text.props.children ?? text.children))
    .join("|");
  await ui.unmount();
  expect(lines.indexOf("活 a")).toBeLessThan(lines.indexOf("上下文"));
});

test("a reading that lands later restarts a row in step with the clock and without sliding it again", async ($, on) => {
  // 真机上撞过:每来一次读数,行上流动的斜纹就被打断一下。带里的图会被重新摆上去,动画从头播;
  // 相位要按最新的时刻算才接得上,报进度时的那一下滑动也不能跟着重播。
  const use = await sessionAfter($, on, [36_400]);
  await begin($);
  await report($, { done: 3 });
  const reported = (await drawingsOn($))[1].source;
  expect(reported).toContain(".pr-row{--at:-1560000ms}");
  expect(reported).toContain("@keyframes pr-fill");
  expect(reported).toContain("@keyframes pr-doing");

  clock.now += 4_000;
  use(60_000);
  await step($);
  const later = (await drawingsOn($))[1].source;
  expect(later).toContain(".pr-row{--at:-1564000ms}");
  expect(later).not.toContain("@keyframes pr-fill");
  expect(later).not.toContain("@keyframes pr-pill");
  // 没有滑动,正在做的那一格也不用等:直接在位置上。
  expect(later).not.toContain("@keyframes pr-doing");
});

test("a report that lands later restarts the gauges in step with the clock and without rolling their numbers again", async ($, on) => {
  const use = await sessionAfter($, on, [36_400]);
  await begin($);
  use(60_000);
  await step($);
  expect((await drawingsOn($))[0].source).toContain(' cw-out"');

  clock.now += 4_000;
  await report($, { done: 3 });
  const later = (await drawingsOn($))[0].source;
  expect(later).toContain(".cw-card{--at:-1564000ms;--since:0ms}");
  expect(later).not.toContain(' cw-out"');
  expect(later).not.toContain("@keyframes cw-stretch");
});

// ---- 探针(10-06)量出来的:带子被重画时,所有图都会被重新摆上去,动画从头播 ----

test("a band drawn again long after the last change stands still: nothing rolls or slides a second time", async ($, on) => {
  // 主人在真机上看到的:切到别的会话再切回来,带子被重画两次,窗口的百分比和上方那个数又滚了一遍,
  // 而什么都没变。入场动画认的是「画的这一刻离那次变化过去了多久」,不是「它是不是最新变的那张」。
  const use = await sessionAfter($, on, [36_400]);
  await begin($);
  use(60_000);
  await step($);
  await report($, { done: 3 });
  const [gauge, row] = await drawingsOn($);
  expect(gauge.source).toContain(' cw-out"');
  expect(row.source).toContain("@keyframes pr-fill");

  clock.now += 10_000;
  const [gaugeAgain, rowAgain] = await drawingsOn($);
  expect(gaugeAgain.source).not.toContain(' cw-out"');
  expect(gaugeAgain.source).not.toContain("@keyframes cw-stretch");
  expect(rowAgain.source).not.toContain("@keyframes pr-fill");
  expect(rowAgain.source).not.toContain("@keyframes pr-doing");
});

test("a band drawn again in the middle of an entrance carries on from where it had got to", async ($, on) => {
  // 一次变化常常连着画两回(回合结束时宿主撤「在跑」和我们写读数,先后不定)。第二回要是从头播,
  // 滑到一半的胶囊就跳回起点。把已经过去的那一段记成负的延迟,新摆上去的图从那儿接着走。
  const use = await sessionAfter($, on, [36_400]);
  await begin($);
  use(60_000);
  await step($);
  clock.now += 100;
  const gauge = (await drawingsOn($))[0].source;
  expect(gauge).toContain(' cw-out"');
  expect(gauge).toContain("--since:-100ms}");
  expect(gauge).toContain(
    ".cw-roll-l .cw-in{animation:cw-in-l .26s cubic-bezier(0.23,1,0.32,1) var(--since) both}",
  );

  await report($, { done: 3 });
  clock.now += 200;
  const row = (await drawingsOn($))[1].source;
  expect(row).toContain("@keyframes pr-fill");
  expect(row).toContain(".pr-row{--since:-200ms}");
  expect(row).toContain("var(--since) both}.pr-pill{");
  // 正在做的那一格本来等 0.3 秒才淡进来,也跟着少等。
  expect(row).toContain(".pr-doing{animation:pr-doing .2s ease-out calc(var(--since) + .3s) both}");
  // 读数是 0.3 秒之前落下的,到这会儿数字已经滚完了。
  expect((await drawingsOn($))[0].source).not.toContain(' cw-out"');
});

// ---- 审查(10-04)查出来的 ----

test("the countdown on a quota gauge counts from when the quota was read, not from when the window was", async ($, on) => {
  await sessionAfter($, on, [36_400], LIMITS);
  expect(await sourceOn($)).toContain(">还剩 2:14<");

  // 闲了一个小时,宿主推来额度的新读数(窗口用量没动):倒计时按这一刻算。
  clock.now += 3_600_000;
  await $.session.measure({
    context: usageOf(36_400, []).context,
    rateLimits: LIMITS,
    changed: ["rateLimits"],
  });
  expect(await sourceOn($)).toContain(">还剩 1:14<");
});

test("a reading with no quota windows in it leaves the quota gauges standing", async ($, on) => {
  const use = await sessionAfter($, on, [36_400], LIMITS);
  await begin($);
  use(60_000, []);
  await step($);

  expect((await cardOn($))?.props.alt).toBe("多云:上下文 30%,60k / 200k;5 小时 23%;本周 29%");
});

test("a window the host cannot size up yet is not drawn as empty: the card waits for the first real count", async ($, on) => {
  // 续接的会话:窗口里已经有东西,但这个进程里还没有回应报过用量,宿主只知道窗口多大。
  await sessionAfter($, on, [-1]);
  // 卡片什么都不画、把这一条让给底下:测试里底下没人画,所以 mount 报的是「没人画」。
  let passed = "";
  try {
    await stackOn($);
  } catch (error) {
    passed = String(error);
  }
  expect(passed).toContain("no implementation for ui.render");

  // 第一次请求收完,接口报了账:窗口里有 120.5k。这是头一个读数,不知道这一轮是从多少起的,不算成这一轮涨的。
  await begin($);
  wire.bill = billOf(120_000, 500);
  await step($);
  const source = await sourceOn($);
  expect(source).toContain(">上下文 120.5k / 200k<");
  expect(spentOn(source)).toBe("+0");
});

test("a request that ended in a compaction is not a reading: the turn does not land on the size from before it", async ($, on) => {
  const use = await sessionAfter($, on, [0, 160_000]);
  await begin($);
  wire.stop = "compaction";
  wire.bill = billOf(180_000, 100);
  use(180_000);
  await step($);
  expect(await sourceOn($)).toContain(">上下文 160k / 200k<");

  // 压完了,宿主说窗口里还剩 40k;回合随后被打断,没有收尾的请求。
  use(180_000);
  compacted.done = true;
  wire.after = 40_000;
  await $.session.compact({ trigger: "auto", messages: [SUMMARY] });
  wire.stop = null;
  wire.bill = null;
  wire.silent = true;
  await $.turn.complete({ ...TURN, isAborted: true, reason: "aborted" });

  expect(await sourceOn($)).toContain(">上下文 40k / 200k<");
});

test("a turn cut short right after a compacting request does not land on the size from before the compaction", async ($, on) => {
  const use = await sessionAfter($, on, [0, 160_000]);
  await begin($);
  wire.stop = "compaction";
  wire.bill = billOf(180_000, 100);
  use(180_000);
  await step($);
  // 回合随即被打断,宿主这会儿也报不出数:卡片留在压缩那次请求之前的读数上,不落到它账上的 180.1k。
  wire.silent = true;
  await $.turn.complete({ ...TURN, isAborted: true, reason: "aborted" });

  expect(await sourceOn($)).toContain(">上下文 160k / 200k<");
});

test("a session that ends in the middle of a turn does not come back looking busy", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await begin($);
  expect(await sourceOn($)).toContain('class="cw-card is-working"');

  await $.session.end({ reason: "other", sessionId: "s", resume: undefined } as never);
  expect(await sourceOn($)).not.toContain('class="cw-card is-working"');
});

for (const [name, input, why] of [
  [
    "more than a hundred steps",
    { phases: [{ name: "扫描", steps: 50_000 }], done: 0 },
    "一件活最多 100 步(现在是 50000 步),把步子并大一些",
  ],
  [
    "more than eight phases",
    { phases: Array.from({ length: 9 }, (_, i) => ({ name: `阶段${i}`, steps: 1 })), done: 0 },
    "阶段最多 8 个",
  ],
] as const) {
  test(`a report with ${name} is turned down`, async ($, on) => {
    await sessionAfter($, on, [36_400]);
    expect(await report($, input)).toBe(`没记上:${why}。`);
  });
}

test("a long phase name is cut to fit the pill, and a bar with many steps drops its small ticks", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await report($, { phases: [{ name: "扫描全部文件再整理", steps: 100 }], done: 10 });

  const row = (await drawingsOn($))[1];
  expect(row.alt).toBe("切片 ⑳ · 图库合并:工作中,扫描全部文件 10/100,10%");
  // 一步只有 4 像素宽,小刻度会糊成一片:不画。
  expect(row.source).not.toContain('class="pr-tick"');
});

test("a row is taken off by its plan alone, and asking for one that is not there says so", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await report($, { done: 3 });

  const gone = await $.tool.call({ tool: PROGRESS, plan: "nope", remove: true } as never);
  expect(String((gone as { result?: unknown }).result)).toBe("没有这一行:nope。带里现在 1 行。");
  const off = await $.tool.call({ tool: PROGRESS, plan: "slice-20", remove: true } as never);
  expect(String((off as { result?: unknown }).result)).toBe(
    "撤掉了:切片 ⑳ · 图库合并。带里现在 0 行。",
  );
});

test("rows nobody has reported on for a week are all taken off together when the next turn starts, and off the disk with them", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await report($, { plan: "总", title: "总进度", done: 1 });
  clock.now += DAY;
  await report($, { plan: "片", title: "这一片", done: 2 });

  // 离最近一次有人报差一分钟满七天:都还在。
  clock.now += 7 * DAY - 60_000;
  await begin($);
  expect(await titlesOn($)).toEqual(["这一片", "总进度"]);

  clock.now += 2 * 60_000;
  await begin($);
  expect(await titlesOn($)).toEqual([]);
  await restart($);
  expect(await titlesOn($)).toEqual([]);
});

test("a row for the whole project, untouched for weeks while a finer row is still being reported on, stays", async ($, on) => {
  // 原先每一行各算各的(一小时,后来一天),真机上总进度那一行被单独收走过 —— 它本来就是好几天才动一下。
  // 现在按整条带最近一次有人报来算:带里还有行在动,就一行都不收。
  await sessionAfter($, on, [36_400]);
  await report($, { plan: "总", title: "总进度", done: 1 });
  clock.now += 20 * DAY;
  await report($, { plan: "片", title: "这一片", done: 2 });
  clock.now += 6 * DAY;
  await begin($);

  expect(await titlesOn($)).toEqual(["这一片", "总进度"]);
});

test("rows picked up after a few days away are still there once the next turn starts, on the band and on the disk", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await report($, { plan: "总", title: "总进度", done: 1 });

  clock.now += 3 * DAY;
  await restart($);
  await begin($);
  expect(await titlesOn($)).toEqual(["总进度"]);
  await restart($);
  expect(await titlesOn($)).toEqual(["总进度"]);
});

test("a subagent silent for an hour (killed, never to finish) is taken off when the next turn starts", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await spawn($);
  clock.now += 61 * 60_000;
  await begin($);

  expect(await titlesOn($)).toEqual([]);
});

test("the rows kept are capped: the oldest give way", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  let last = "";
  for (const plan of ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"]) {
    clock.now += 1_000;
    last = await report($, { plan, title: `活 ${plan}`, done: 1 });
  }
  expect(last).toBe("记下了:活 l,勘察 0.1/3,一共 1/9。带里现在 10 行。");
});

test("a count just short of a million reads as 1M, not 1000k", async ($, on) => {
  await sessionAfter($, on, [999_960]);
  expect(String((await cardOn($))?.props.alt)).toContain("1M / 200k");
});

// ---- 落盘:进度行跨进程重启留着 ----

/**
 * 应用重启后续上同一个会话:宿主替会话存着的状态没了,盘上的还在,会话 id 没变,会话重新开始。
 * 被测的模块没有重新加载 —— 接回来靠的是状态里有没有行,不是模块里记的什么。
 */
const restart = async ($: Engine) => {
  host.isStateLost = true;
  await $.session.start(START);
};

test("work reported before the app restarts is back on the band when the session is picked up again", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await report($, { plan: "总", title: "总进度", done: 1 });
  await report($, { plan: "片", title: "这一片", done: 3, status: "decide" });

  await restart($);

  expect((await drawingsOn($)).slice(1).map((row) => row.alt)).toEqual([
    "这一片:等你拍板,施工 1.1/3,33%",
    "总进度:勘察阶段,勘察 0.1/3,11%",
  ]);
});

/** 带里的行,从上到下各是什么样(最下面的仪表不算)。 */
const rowsOn = async ($: Engine) => (await stackOn($)).slice(0, -1).map((row) => row.alt);

test("what comes back after a restart follows every way the rows change, not only reports", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await report($, { plan: "总", title: "总进度", done: 1 });
  await report($, { plan: "片", title: "这一片", done: 6, status: "decide" });

  // 主人发话:等拍板的行回到工作中。
  await $.prompt.submit({ text: "就这样" } as never);
  await restart($);
  expect(await rowsOn($)).toEqual([
    "这一片:工作中,施工 1.4/3,67%",
    "总进度:勘察阶段,勘察 0.1/3,11%",
  ]);

  // 做完的行看过一轮,新的一轮开始时收起。
  await report($, { plan: "片", title: "这一片", done: 9 });
  await begin($);
  await restart($);
  expect(await rowsOn($)).toEqual(["总进度:勘察阶段,勘察 0.1/3,11%"]);

  // 撤掉的行不回来。
  await $.tool.call({ tool: PROGRESS, plan: "总", remove: true } as never);
  await restart($);
  expect(await rowsOn($)).toEqual([]);
});

test("readings that move the gauges alone do not write to the disk", async ($, on) => {
  const use = await sessionAfter($, on, [36_400]);
  await report($, { done: 3 });
  const written = host.writes;
  expect(written).toBeGreaterThan(0);

  // 一整轮:开始、两次模型请求、答完 —— 窗口的读数一路在变,行上「上一次画的步数」也拨过了,行本身没变。
  await begin($);
  use(52_000);
  await step($);
  use(61_000);
  wire.last = true;
  await step($, { index: 1 });
  await $.turn.complete(TURN);

  expect(host.writes).toBe(written);
});

test("a hot reload (the session starts again with its state still there) keeps the rows on the band over the ones on the disk", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await report($, { plan: "总", title: "总进度", done: 1 });
  // 这一次没写成盘:盘上还是只有总进度那一行。
  host.isDiskDown = true;
  await report($, { plan: "片", title: "这一片", done: 3 });
  host.isDiskDown = false;

  await $.session.start(START);

  expect(await titlesOn($)).toEqual(["这一片", "总进度"]);
  // 盘上落后的那份也在这时补齐了:随后重启,两行都接得回来。
  await restart($);
  expect(await titlesOn($)).toEqual(["这一片", "总进度"]);
});

test("rows that were on the band before any of this reached the disk are saved as soon as the session starts again", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await report($, { plan: "总", title: "总进度", done: 1 });
  // 落盘这件事上线之前报的行:只在状态里,盘上没有。
  host.disk.clear();

  await $.session.start(START);
  await restart($);

  expect(await titlesOn($)).toEqual(["总进度"]);
});

test("a session that starts while the disk cannot be read leaves what is on the disk alone", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await report($, { plan: "总", title: "总进度", done: 1 });

  // 只是读不了,写还行:这时候拿状态里的(空的)去落盘,会把盘上的删掉。
  host.isDiskUnreadable = true;
  await restart($);
  expect(await titlesOn($)).toEqual([]);
  host.isDiskUnreadable = false;
  await restart($);

  expect(await titlesOn($)).toEqual(["总进度"]);
});

test("a report is taken and shown even when the disk cannot be written", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  host.isDiskDown = true;

  expect(await report($, { done: 3 })).toBe(
    "记下了:切片 ⑳ · 图库合并,施工 1.1/3,一共 3/9。带里现在 1 行。",
  );
  expect(await titlesOn($)).toEqual(["切片 ⑳ · 图库合并"]);
});

test("each session keeps its own rows: another session picked up in between sees none of them", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await report($, { plan: "总", title: "总进度", done: 1 });

  host.session = "s-2";
  await restart($);
  expect(await titlesOn($)).toEqual([]);
  await report($, { plan: "别", title: "别的活", done: 2 });

  host.session = "s-1";
  await restart($);
  expect(await titlesOn($)).toEqual(["总进度"]);
});

test("a report that arrives after a restart before the session has started again adds to the rows on the disk", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await report($, { plan: "总", title: "总进度", done: 1 });

  host.isStateLost = true;
  expect(await report($, { plan: "片", title: "这一片", done: 3 })).toBe(
    "记下了:这一片,施工 1.1/3,一共 3/9。带里现在 2 行。",
  );
  await restart($);

  expect(await titlesOn($)).toEqual(["这一片", "总进度"]);
});

test("reports made at the same moment all reach the disk, even when the first write is the slowest", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  // 头一次写盘卡住,等三件活都进了带再放行:不排队的话它最后落下去,盘上留下的就是只有一行的那份旧的。
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let isFirst = true;
  host.onWrite = () => {
    if (!isFirst) return;
    isFirst = false;
    return gate;
  };
  const reports = ["总", "期", "片"].map((plan) =>
    report($, { plan, title: `活 ${plan}`, done: 1 }),
  );
  let shown: string[] = [];
  for (let look = 0; look < 50 && shown.length < 3; look++) shown = await titlesOn($);
  expect(shown.length).toBe(3);
  release();
  await Promise.all(reports);

  await restart($);

  expect((await titlesOn($)).sort()).toEqual(["活 总", "活 期", "活 片"].sort());
});

test("a row picked up after a restart sits where the work had got to: the bar does not slide in from the start again", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await report($, { done: 3 });
  await begin($);
  wire.last = true;
  await step($);
  await $.turn.complete(TURN);
  const settled = (await stackOn($))[0].source;

  // 重启那一下宿主还报不出窗口用量:带里最新的时刻就是这一行自己的,它要是记成「从 0 滑过来」就会再滑一遍。
  wire.silent = true;
  await restart($);

  expect(unphased((await stackOn($))[0].source)).toBe(unphased(settled));
});

/** 盘上的一行,照落盘的样子写:以前的版本写下的也得接得回来。 */
const SAVED = { plan: "总", title: "总进度", phases: PHASES, done: 1, at: NOW };

test("rows an earlier run left on the disk come back; whatever does not read as a row is left out and nothing breaks", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  host.disk.set("rows:s-1", [
    SAVED,
    null,
    "x",
    { ...SAVED, plan: "没有阶段", phases: [] },
    { ...SAVED, plan: "没有时刻", at: undefined },
    { ...SAVED, plan: "片", title: "这一片", done: 3, status: "decide" },
  ]);
  await restart($);
  expect(await rowsOn($)).toEqual([
    "这一片:等你拍板,施工 1.1/3,33%",
    "总进度:勘察阶段,勘察 0.1/3,11%",
  ]);

  // 再多也只接回记得下的那么多行,靠后的(后报的)留下。
  host.disk.set(
    "rows:s-1",
    Array.from({ length: 14 }, (_, i) => ({ ...SAVED, plan: `p${i}`, title: `活 ${i}` })),
  );
  await restart($);
  expect(await titlesOn($)).toEqual([
    "活 13",
    "活 12",
    "活 11",
    "活 10",
    "活 9",
    "活 8",
    "活 7",
    "活 6",
    "活 5",
    "活 4",
  ]);

  host.disk.set("rows:s-1", "garbage");
  await restart($);
  expect(await rowsOn($)).toEqual([]);
  expect((await drawingsOn($))[0].alt).toBe("晴朗:上下文 18%,36.4k / 200k");
});

test("rows left by sessions nobody has reported in for a month are cleared off the disk when a session is picked up; its own are not", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  host.disk.set("rows:s-1", [{ ...SAVED, at: NOW - 40 * DAY }]);
  host.disk.set("rows:gone", [{ ...SAVED, at: NOW - 31 * DAY }]);
  host.disk.set("rows:recent", [
    { ...SAVED, at: NOW - 31 * DAY },
    { ...SAVED, plan: "片", at: NOW - 29 * DAY },
  ]);
  host.disk.set("rows:junk", "garbage");
  host.disk.set("other", { kept: true });

  await restart($);

  expect([...host.disk.keys()].sort()).toEqual(["other", "rows:recent", "rows:s-1"]);
  expect(await titlesOn($)).toEqual(["总进度"]);
});

test("the clearing never takes the session's own rows off the disk, whichever event picks them up first", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  host.disk.set("rows:s-1", [{ ...SAVED, at: NOW - 40 * DAY }]);

  // 重启之后头一件事不是会话开始,是主人发话:行在这儿接回来,这一下不改行,所以也不会再落一次盘。
  host.isStateLost = true;
  await $.prompt.submit({ text: "继续" } as never);
  await restart($);

  expect(await titlesOn($)).toEqual(["总进度"]);
});

// ---- 口吻与图标 ----

test("the mod speaks in a neutral voice: the rows, the tool's description and the usage note talk of the user, never of a master", async ($, on) => {
  // 原先是女仆的口吻(「等主人拍板」「跑了 N 趟」);主人说这个 mod 和女仆的关系不大了,口吻改中性,图标留着。
  on("prompt.context", async (_, e) => ({ blocks: [...e.blocks] }));
  await sessionAfter($, on, [36_400]);
  expect(host.tools.length).toBe(1);
  expect(JSON.stringify(host.tools)).toContain("等用户拍板");
  expect(JSON.stringify(host.tools)).not.toContain("主人");

  await report($, { done: 6, status: "decide" });
  expect((await stackOn($))[0].alt).toContain("等你拍板");

  const { blocks } = await $.prompt.context({ blocks: [] } as never);
  expect(blocks[0].text).not.toContain("主人");
});

test("the row icons: a gear that turns while the turn runs and a bell that rings while a decision is awaited; a subagent keeps its three turning dots", async ($, on) => {
  await sessionAfter($, on, [36_400]);
  await report($, { done: 4 });
  await begin($);
  const working = (await drawingsOn($))[1].source;
  // 工作中是齿轮,回合跑着才转(试过扫帚:图标太小,看不出是什么,主人说换回来)。
  expect(working).toContain(
    '<g class="pr-icon i-working" fill="#fff"><rect x="-1.3" y="-6.8" width="2.6" height="3.2" rx="0.8" transform="rotate(0)"/>',
  );
  expect(working).toContain(".i-survey,.i-working,.pr-ring{transform-origin:0 0}");
  expect(working).toContain("@keyframes pr-spin{to{transform:rotate(360deg)}}");
  expect(working).toContain(".is-working .i-working{animation:pr-spin 3.2s linear");
  expect(working).not.toContain("pr-sweep");
  expect(working).not.toContain("pr-dust");

  await report($, { done: 6, status: "decide" });
  const waiting = (await drawingsOn($))[1].source;
  expect(waiting).toContain('class="pr-ring"');
  // 铃在等的时候也摇:不看回合在不在跑。
  expect(waiting).toContain(".pr-ring{animation:pr-ring");
  expect(waiting).not.toContain(".is-working .pr-ring");
  expect(waiting).not.toContain(">?<");

  await spawn($);
  // 子代理还是原来那三个点,在跑的时候转(试过戴头饰的小女仆,主人说换回来);说法是中性的「N 个工具轮」。
  const agent = (await stackOn($))[0].source;
  expect(agent).toContain(
    '<g class="pr-icon i-agent" fill="#fff"><circle cy="-4.2" r="2.1"/><circle cx="3.7" cy="2.2" r="2.1"/><circle cx="-3.7" cy="2.2" r="2.1"/></g>',
  );
  expect(agent).toContain(".is-working .i-agent{animation:pr-spin");
  expect(agent).toContain(">0 个工具轮<");
  expect(agent).not.toContain("pr-blink");
});

test("the two quota gauges: a pocket watch for the 5 hours, a duty roster for the week, their marks in the colour of the level", async ($, on) => {
  await sessionAfter($, on, [36_400], LIMITS);
  const source = await sourceOn($);

  // 5 小时用了 23%(晴朗那一档,深色 #e17055):怀表的两根针。
  expect(source).toContain(
    '<path d="M0,1.6 L0,-2.4 M0,1.6 L2.8,3.2" fill="none" stroke="#e17055" stroke-width="1.4" stroke-linecap="round"/>',
  );
  // 本周用了 29.4%(多云那一档,深色 #0984e3):值班表上的三行字。
  expect(source).toContain(
    '<path d="M-3,-1.4 L3,-1.4 M-3,1.6 L3,1.6 M-3,4.6 L0.8,4.6" fill="none" stroke="#0984e3" stroke-width="1.3" stroke-linecap="round"/>',
  );
  // 原先的沙漏和日历不在了。
  expect(source).not.toContain("M-5,-7 H5 L0,0 Z");
  expect(source).not.toContain('<rect x="-7" y="-5.5" width="14" height="12.5" rx="3"/>');
});

// ---- 用法随 mod 走 ----

test("the mod brings its own usage note into the conversation, after whatever the engine put there, and the tool it names is the one that answers", async ($, on) => {
  // 测试自己的钩子要在头一次动 $ 之前挂好。
  on("prompt.context", async (_, e) => ({ blocks: [...e.blocks] }));
  await sessionAfter($, on, [36_400]);

  const { blocks } = await $.prompt.context({
    blocks: [
      { name: "claudeMd", text: "x" },
      { name: "currentDate", text: "today" },
    ],
  } as never);
  expect(blocks.map((block) => block.name)).toEqual(["claudeMd", "currentDate", "contextBand"]);
  expect(blocks.slice(0, 2).map((block) => block.text)).toEqual(["x", "today"]);

  const note = blocks[2].text;
  for (const piece of ["ToolSearch", "plan", '"decide"', "remove: true", "子代理"])
    expect(note).toContain(piece);
  // 大工程怎么报也在里面:装了 mod 就不用再往 CLAUDE.md 里写一个字(主人:要开箱即用)。
  for (const piece of [
    "大工程报三条",
    "整个工程",
    "手上这一件",
    "不单列阶段",
    "更新第三条",
    "报一条就够",
  ])
    expect(note).toContain(piece);
  // 这段说明子代理的对话里也收得到(真机上看过),得有一句直接说给它听。
  expect(note).toContain("你自己就是被派出去的子代理时不要报");
  // 行尾带不带小环只看眼下这个阶段分不分步,说明得跟着实现说。
  expect(note).toContain("眼下这个阶段自己还分步时,分数左边多一个小环");
  // 说明里写的工具名就是真会应答的那个:照着它去调,拿得到回执。
  const [tool] = note.match(/mcp__[a-z-]+__progress/) ?? [];
  const answer = await $.tool.call({
    tool,
    plan: "p",
    title: "活",
    phases: [{ name: "做", steps: 2 }],
    done: 0,
  } as never);
  expect(String((answer as { result?: unknown }).result)).toBe(
    "记下了:活,做 0/2,一共 0/2。带里现在 1 行。",
  );
});

test("a usage note already in the conversation is not carried twice", async ($, on) => {
  on("prompt.context", async (_, e) => ({
    blocks: [...e.blocks, { name: "contextBand", text: "stale" }],
  }));
  await sessionAfter($, on, [36_400]);

  const { blocks } = await $.prompt.context({ blocks: [{ name: "claudeMd", text: "x" }] } as never);
  expect(blocks.map((block) => block.name)).toEqual(["claudeMd", "contextBand"]);
  expect(blocks[1].text).not.toBe("stale");
});

// ---- 一次请求在服务端跑了几遍 ----

test("a request the server ran twice (it asked a server-side tool in the middle) is billed for both passes: the window is one pass, not the sum", async ($, on) => {
  // 真机上撞过(10-05):窗口本来 58%,一轮答完突然成了 117%、柱子 +630k。那一轮最后一次请求中途问了一次服务端的「顾问」,
  // 模型在服务端跑了两遍,接口的账把两遍的输入加在了一起(1 166k),而宿主自己的读数还是 584k。
  const use = await sessionAfter($, on, [0, 54_000]);
  await begin($);
  use(58_420);
  // 两遍各带着 58 420 进去,合起来 116 840;一共出来 1 155。
  wire.bill = billOf(116_840, 1_155);
  wire.last = true;
  await step($);
  await $.turn.complete(TURN);

  const source = await sourceOn($);
  expect(source).toContain(">上下文 59.6k / 200k<");
  expect(spentOn(source)).toBe("+5.6k");
});

test("a bill that is not a whole number of passes over what the host read is taken as it stands", async ($, on) => {
  // 宿主的读数万一落后一步(这次请求带进去一大段工具结果),账会比它大一截,但不是整数倍:照账算,不去除。
  const use = await sessionAfter($, on, [0, 54_000]);
  await begin($);
  use(60_000);
  wire.bill = billOf(96_000, 1_000);
  await step($);

  expect(await sourceOn($)).toContain(">上下文 97k / 200k<");
});
