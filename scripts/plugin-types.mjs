// 类型检查前,先让本机的 Claude Code 把 .claude-plugin/types/ 写出来或刷新。
//
// 这个目录是引擎生成的,不入库;缺了它,根目录 tsconfig 的 extends 落空,tsc 会退回默认配置:
// 满屏假错误。所以 typecheck 脚本先跑这个。--init-only 只跑 Setup 和 SessionStart 钩子就退出,
// 不发模型请求;配置目录用临时的,免得碰用户自己的 ~/.claude。
// 非交互模式下引擎默认不写类型,CLAUDE_CODE_PLUGIN_DIR_WATCH=1 才写,别当成「盯文件夹」删掉。
// --init-only 和这个变量都不在 help 里:哪天失效,缺类型的检出会在这里报错,已有类型的照用旧的。

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const needed = [
  path.join(root, ".claude-plugin/types/tsconfig.json"),
  path.join(root, ".claude-plugin/types/claude-code/index.d.ts"),
];
const present = () => needed.every((file) => existsSync(file));

const config = mkdtempSync(path.join(tmpdir(), "context-band-types-"));
let reason = "";
let tail = "";
try {
  // 继承来的 CLAUDE_CODE_PLUGIN_DIRS 会让引擎顺手往别的目录也写类型,删掉。
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: config,
    CLAUDE_CODE_PLUGIN_DIR_WATCH: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  delete env.CLAUDE_CODE_PLUGIN_DIRS;
  const run = spawnSync("claude", ["--plugin-dir", root, "--init-only"], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 60_000,
  });
  if (run.error) reason = `没能运行 claude:${run.error.message}`;
  else if (run.status !== 0) reason = `claude 退出码 ${run.status ?? run.signal}`;
  tail = `${run.stdout ?? ""}\n${run.stderr ?? ""}`.trim().split("\n").slice(-5).join("\n");
} finally {
  rmSync(config, { recursive: true, force: true });
}

if (!present()) {
  console.error(
    `.claude-plugin/types/ 没铺出来${reason ? `(${reason})` : ""}。\n` +
      (tail ? `claude 输出的最后几行:\n${tail}\n` : "") +
      "请装好 Claude Code CLI,或者用 `claude --plugin-dir .` 加载一次这个文件夹。",
  );
  process.exit(1);
}
if (reason) console.error(`警告:没能刷新 .claude-plugin/types/,用的是现有类型(${reason})。`);
