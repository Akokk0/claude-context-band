// 提示词缓存的账:主对话的每次请求,缓存替它读了多少、离过期还有多久。纯函数。
//
// 口径照官方文档(prompt-caching 和 statusline 两页):引擎自己也算了一份(/usage 里那一行、状态栏脚本拿到的
// `prompt_cache`),但插件的接口里拿不到,只能用每次请求的账自己算。子代理的请求不算,它们各有各的缓存。

import type { Cache, Limits } from "../types";
import { passesOf } from "./forecast";

/** 接口给一次请求报的账里,进去的那三样。 */
type Sent = {
  input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};

/** 少读了这么多(占本来读得到的比例、绝对数量,两样都过线)才算一次没命中。文档的数。 */
const MISS_SHARE = 0.05;
const MISS_TOKENS = 2_000;

/**
 * 主对话又收完一次请求。`host` 是宿主此刻报的窗口用量,只用来看这次请求在服务端跑了几遍
 * (账是每一遍加起来的,拿它和上一次留下的量比之前要先除回去)。
 * 从没见过缓存、这一次也没有:不记,仪表底下那一条就不画(缓存关着,或者这条线路不报)。
 */
export function withRequest(
  cache: Cache | undefined,
  bill: Sent,
  host: number | undefined,
  at: number,
  life: number,
): Cache | undefined {
  const sent = bill.input_tokens + bill.cache_read_input_tokens + bill.cache_creation_input_tokens;
  if (!cache && bill.cache_read_input_tokens + bill.cache_creation_input_tokens === 0)
    return undefined;
  const passes = passesOf(sent, host);
  const held = cache?.held ?? 0;
  const short = held - bill.cache_read_input_tokens / passes;
  const missed = short >= MISS_TOKENS && short > held * MISS_SHARE;
  return {
    read: (cache?.read ?? 0) + bill.cache_read_input_tokens,
    sent: (cache?.sent ?? 0) + sent,
    misses: (cache?.misses ?? 0) + (missed ? 1 : 0),
    held: Math.round(sent / passes),
    at: at || (cache?.at ?? 0),
    life,
  };
}

/** 整个会话进去的 token 里,缓存读出来的占百分之几。往下取整:有过没命中就不该写成 100%。 */
export function hitOf(cache: Cache): number {
  return cache.sent > 0 ? Math.floor((cache.read / cache.sent) * 100) : 0;
}

const MINUTE = 60_000;

/**
 * 主对话的缓存闲多久就过期。接口不告诉插件是哪一档,照文档的规矩推:
 * 走订阅、额度还没用完是一小时;额度用完了(开始走另算的用量)、或者根本读不到额度(API key、云厂商)是五分钟。
 * 用户自己在设置里改过档位的话这里看不到,会推错。
 * 在请求收完的那一刻推、和账记在一起:额度之后再变(窗口重置了),已经写下的那份缓存还是原来那一档。
 */
export function lifeOf(limits: Limits): number {
  const windows = [limits.fiveHour, limits.sevenDay].filter((quota) => quota !== undefined);
  const isWithinPlan = windows.length > 0 && windows.every((quota) => quota.percent < 100);
  return (isWithinPlan ? 60 : 5) * MINUTE;
}

/** 那一档叫什么。 */
export const lifeWord = (life: number) =>
  life >= 60 * MINUTE ? "1 小时档" : `${Math.round(life / MINUTE)} 分钟档`;

/** 还能用几分钟,往上取整:刚收完请求是满的那个数,最后不到一分钟写 1。 */
export const minutesLeft = (left: number) => Math.ceil(left / MINUTE);

/**
 * 再过多久重画一回带子:分钟数刚变的那一下(多等四分之一秒,免得钟差一点点、画出来还是原来的数)。
 * 最后一回落在刚过期的时候,画成过期的样子。
 */
export const tickIn = (left: number) => (left % MINUTE || MINUTE) + 250;
