// win-quote.js —— Windows 命令行参数引号化（纯函数，零依赖，可单测）。
//
// 为什么需要它：spawnClaudeCodeProcess 在 win32 上要把 SDK 给的 argv 数组拼成一条
// 命令行字符串交给 cmd.exe。cmd 的引号规则与 POSIX 不同：参数里的双引号要写成 \"，
// 且含空格/特殊字符的参数必须整体加引号。拼错的症状是 CLI 收到被截断或合并的参数
// （--settings 的 JSON 值里全是双引号，正是最容易拼错的一类）。
//
// 规则（Microsoft C 运行时的 argv 解析约定，cmd 层再套一层引号剥离）：
//   · 参数含空格、制表符或双引号 → 整体用双引号包起来；
//   · 参数内部的双引号 → 转义为 \"；
//   · 结尾的反斜杠在引号前需翻倍（本场景参数不会出现，不额外处理，保持最小实现）。
// 不做的事：不处理 %VAR% 展开、不处理 ^ 转义——argv 里的值来自 SDK 与本项目配置，
// 不含 cmd 元字符的注入面；若未来出现用户可控参数进 argv，需在此加 ^ 转义。

/**
 * 把单个参数按 Windows 命令行约定引号化。
 * @param {string} arg 原始参数
 * @returns {string} 可直接拼进命令行的形式
 */
export function quoteWinArg(arg) {
  const s = String(arg ?? '');
  if (s === '') return '""';
  if (!/[\s"]/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

/**
 * 把 argv 数组拼成一条 Windows 命令行字符串。
 * @param {string[]} argv 含命令本体在内的参数数组
 * @returns {string} 命令行字符串
 */
export function joinWinCommand(argv) {
  return argv.map(quoteWinArg).join(' ');
}
