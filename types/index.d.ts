/** 一次读数:上下文窗口此刻用了多少。 */
export type Reading = { tokens: number; window: number; percent: number };

/** 答完的一轮:它让窗口涨了多少(压缩过的那一轮是负数),答完时窗口用到百分之几。 */
export type Turn = { spent: number; percent: number };

/**
 * 窗口那一格画的东西:此刻的读数、上一次画的读数(数字从它跳到此刻的)、
 * 正在跑的这一轮开始时窗口里有多少(这一轮涨了多少从它起算)、这个读数是什么时候读的。
 */
export type Gauge = { now: Reading; was: Reading; base: number; at: number };

/** 一个额度窗口此刻用掉了百分之几;什么时候重置,服务端没给就没有。 */
export type Quota = { percent: number; resetsAt?: string };

/** 账号的两个额度窗口。哪个没有读数就没有哪个(不走订阅的账号两个都没有)。 */
export type Limits = { fiveHour?: Quota; sevenDay?: Quota };

/** 一件活的一个阶段:叫什么、几步、是不是勘察类(只看不改的那种)。 */
export type Phase = { name: string; steps: number; survey?: boolean };

/** 一行进度的四种状态:勘察阶段、工作中、等主人拍板、做完了。 */
export type RowStatus = "survey" | "working" | "decide" | "done";

/**
 * 一件报上来的活:是哪件(plan)、标题、阶段、一共做完了几步、报的人明说的状态(没说就由步数推)、
 * 上一次画的时候做完了几步(条和胶囊从那儿滑过来)、什么时候报的。
 */
export type Row = {
  plan: string;
  title: string;
  phases: Phase[];
  done: number;
  status?: RowStatus;
  was: number;
  at: number;
};

/**
 * 一个派出去的子代理:是谁(宿主给的 id)、标题(派它时写的那句描述)、发过几次模型请求、什么时候派的、
 * 最近一次有动静是什么时候。跑完了记下是做完还是停了、收场的是哪一轮(那一轮迟到的请求不算它又跑起来);
 * 主循环听它回报的那一轮答完时收起。
 */
export type Agent = {
  id: string;
  title: string;
  steps: number;
  since: number;
  at: number;
  ended?: "done" | "stopped";
  endedTurn?: string;
  /** 它跑在哪个模型上:宿主说的那个 id 或别名,原样记着。 */
  model?: string;
  /** 它最近一次请求要模型想得多用力:五档里的一档,或一个预算数;那次请求不带就没有。 */
  effort?: string | number;
};

/**
 * 主对话的提示词缓存:整个会话里缓存读出来多少、一共进去多少、没命中几次、
 * 最近一次请求留在缓存里多少(下一次请求本来读得到的量;压缩之后是 0,那一次重建不算没命中)、
 * 最近一次请求是什么时候收完的、那一次请求的缓存闲多久过期(毫秒;从那一刻起算还能用多久)。
 */
export type Cache = {
  read: number;
  sent: number;
  misses: number;
  held: number;
  at: number;
  life: number;
};

/**
 * 卡片画的全部东西,放在一起:一次事件只写一次,宿主就只换一次图。
 * 分开放的话,读一次数要写两三回,整张图跟着换两三回,看上去就是闪。
 */
export type Card = {
  gauge: Gauge | null;
  turns: Turn[];
  limits: Limits;
  /** 额度是什么时候读的:「还剩多久」从这一刻算。还没读过就没有。 */
  limitsAt?: number;
  /**
   * 主循环的一轮在不在跑。卡片只看这个,不看宿主给的「在干活」:
   * 一轮结束时那个标记和这里的读数先后不定,两样都看的话中间会画出一张半截的图。
   */
  running: boolean;
  /** 主对话的缓存账。还没有哪次请求报过缓存就没有,仪表底下那一条也不画。 */
  cache?: Cache;
  /** 报上来的活,一件一行,按最近报的排在后面。还没人报过就没有。 */
  rows?: Row[];
  /** 派出去的子代理,一个一行,排在进度行上面。 */
  agents?: Agent[];
};

declare module "claude-code" {
  interface PluginState {
    "context-band": { card: Card };
  }
}
