// 面板版本号：**唯一真源**。
//
// 以前三处各写各的：package.json 是 2.9.0、扩展 manifest 是 2.8、
// /api/external/hello 回的 server_version 还停在 2.3 —— 排障时问「你装的哪版」，
// 三个地方三个答案。现在面板自己的版本只写在这里：
//   · /api/external/hello 的 server_version 用它（扩展弹窗的「面板连接检查」会显示）
//   · 测试会断言 package.json 的 version 和它一致（改了这里忘了改那边会直接报红）
// 扩展的版本在 public/ext-src/manifest.json 里（它有自己的发布节奏：改过扩展代码，
// 用户就得重新下载 + 在 chrome://extensions 点一次「重新加载」，所以必须单独能看出来）。
export const PANEL_VERSION = '2.20.0';
