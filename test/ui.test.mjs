// 账号页 UI 契约 + 「粘贴 → 体检 → 自动保存」流程的源码级测试
// 说明：账号页是内联在 public/index.html 里的真实脚本（没有构建步骤），
// 所以这里读源码断言关键结构，把这些约定钉住：
//   ①「签到时间」统一叫「全局签到」；
//   ② 左右两栏的标题行 / 说明段 / 底边三处对齐的钩子都在；
//   ③ 粘贴区是一个像样的默认框（5 行 + 等宽 + 自动长高 + 清空 + 实时体检）；
//   ④ 保存前有逻辑性体检，硬错误不许保存、域名对不上先确认；
//   ⑤ 保存成功才清空粘贴框；加完账号会滚过去把那一行闪一下。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'public', 'index.html'), 'utf8');
const tools = readFileSync(join(root, 'public', 'cookie-tools.js'), 'utf8');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

t('「签到时间」统一叫「全局签到」（表格列名 + 卡片标题 + 胶囊文案）', () => {
  assert.match(html, /<th class="c">全局签到<\/th>/, '表格列名要叫「全局签到」');
  assert.match(html, /<h2>全局签到<\/h2>/, '左侧卡片标题要叫「全局签到」');
  assert.doesNotMatch(html, /follow \? `跟随 \$\{time\(\)\}`/, '胶囊文案不该再是「跟随 xx:xx」');
  assert.match(html, /textContent = follow \? `全局 \$\{time\(\)\}` : time\(\)/, '胶囊要显示「全局 xx:xx」');
  assert.match(html, /<span class="tp-tag hidden">单独<\/span>/, '单独设过时间的账号要有「单独」标记');
  assert.match(html, /renderTimePicker\(el, initHour \|\| GLOBAL_HOUR, \{ follow: !initHour, followTag: true \}\)/, '账号行的时间胶囊要开 followTag');
  assert.match(html, /全局签到 \$\{displayTime\}/, '顶部那行也要用「全局签到」的说法');
});

t('账号页是单栏整幅：两栏、以及为了「对齐两栏」而设的固定高度都拆掉了', () => {
  // 【改过两版】先是两栏 stretch + push-bottom（左栏中间一个大洞），
  // 再是两栏 align-items:start（左栏不空了，但右栏下面又空一块）。
  // 现在直接单栏整幅：「粘贴」和「解析」都是要贴一大串 Cookie 的活，越宽越好用，
  // 也就根本不存在“两栏不一般高”的问题。
  assert.doesNotMatch(html, /class="two-col"/, '不该再有两栏容器');
  assert.doesNotMatch(html, /class="col-head"/, '不该再有栏内标题行（改用 .card-head）');
  assert.doesNotMatch(html, /class="col-tip"/, '不该再有栏内说明段（改用 .card-tip）');
  assert.doesNotMatch(html, /class="vline"/, '不该再有两栏之间的竖线');
  assert.doesNotMatch(html, /min-height:64px/, '不该再有「固定三行高」这种为对齐而生的写法');
  assert.doesNotMatch(html, /\.two-col|\.mini-grid|push-bottom|today-mini|recent-mini/, '这些布局套子都该拆干净');
  // 说明段改成按内容自然排（不再固定高度）
  assert.match(html, /\.card-tip \{ font-size:12\.5px; line-height:1\.7; color:var\(--muted\); margin:0 0 12px; \}/,
    '说明段应该按内容自然排');
  assert.equal((html.match(/<div class="card-tip"/g) || []).length, 0, '.card-tip 是 p 不是 div');
  // 只剩「添加 / 更新账号」那张卡里的两段（粘贴 + 解析器各一段）——
  // 【2026-09-29】全局签到卡里那段三行说明收进了「💡 说明」悬浮气泡（那里太占版面），
  // 所以这里从 >= 3 改成 >= 2；要求仍然成立：说明段一律走 .card-tip，不许写死行高/内联样式。
  assert.ok((html.match(/class="card-tip"/g) || []).length >= 2, '说明段仍要用 .card-tip');
  // 内层小块共用一套度量（同圆角/描边/内边距）
  assert.match(html, /\.sched-bar, \.paste-box, \.ckb \{\n\s*border-radius:var\(--radius-sm\); border:1px solid var\(--line\);/,
    '内层小块要共用一套度量');
  // 账号页就三张卡：表格 / 全局签到 / 添加更新
  for (const id of ['accounts-body', 'sched-tp', 'sched-tz', 'ck-paste']) {
    assert.ok(html.includes('id="' + id + '"'), '账号页缺少 ' + id);
  }
});

t('浏览器扩展不在账号页：下载、安装步骤、API Key 全在设置里一处', () => {
  // 扩展是**一次性的安装动作**：装完一辈子不用再点。让它常年占着账号页最下面一大块
  // （还要为它多读一次在线状态）不划算 —— 账号页回到只干「签到」这件事。
  const accTab = html.slice(html.indexOf('<section id="tab-accounts">'), html.indexOf('<section id="tab-logs"'));
  // 按 **DOM** 断言，不按注释文字（源码里留的那句「搬走了」的注释不算）
  assert.ok(!/href="\/checkin-helper\.zip"/.test(accTab), '账号页不该再有扩展下载入口');
  assert.ok(!/<summary>安装步骤/.test(accTab), '账号页不该再有安装步骤');
  assert.ok(!html.includes('id="ext-box-state"'), '那个「已安装 · 在线」小徽章也没了');
  assert.ok(!html.includes("btn-ext-help"), '旧的「📖 安装步骤」折叠按钮已改为 <details>，不该还留着');
  // 设置页那一张卡：详细说明 + 下载 + 安装步骤 + API Key
  const setTab = html.slice(html.indexOf('<section id="tab-settings"'));
  assert.match(setTab, /<h2>🔌 浏览器扩展（签到面板助手）<\/h2>/, '设置页要有扩展这一张卡');
  assert.match(setTab, /一键取 Cookie/, '① 一键取 Cookie 的说明要搬过来');
  assert.match(setTab, /当「本地网络中继」/, '② 本地网络中继的说明要搬过来');
  assert.match(setTab, /用不着在弹窗里点任何「执行」/, '「弹窗不用点」这句也别丢');
  assert.match(setTab, /href="\/checkin-helper.zip"[^>]*download/, '下载入口在设置页');
  assert.match(setTab, /<summary>安装步骤（4 步，约 1 分钟）<\/summary>/, '安装步骤也在设置页');
  assert.match(setTab, /id="ext-api-key"/, 'API Key 跟它们放在同一张卡里（说明里那句「填下面这把 API Key」才成立）');
});

t('「全局签到」压成一行（时间 / 时区各按内容宽，说明收进悬浮气泡）', () => {
  // 【为什么】它只有两个值要看，却曾经是「标签一行 + 胶囊整幅一行」×2 + 三行说明 ≈ 290px 高，
  // 把底下的账号表直接推下一屏。现在一行放下：「每天 08:05 ｜ 时区 中国台湾 · 台北 ｜ 💡 说明」。
  assert.match(html, /\.sched-bar \{ margin-top:0; display:flex; flex-wrap:wrap; align-items:center; gap:8px 10px; \}/,
    '.sched-bar 要是一行、窄了自动折行');
  // 两个胶囊不再占满整幅（那是「上下排」时代的写法），高度也从 44 收到 38
  assert.match(html, /\.sched-bar \.tp-chip\.lg, \.sched-bar \.tz-chip \{\n\s*height:38px;/, '两个胶囊统一 38px 高');
  assert.doesNotMatch(html, /width:100%; height:44px; padding:0 12px; justify-content:center/, '旧的「占满整幅」要删干净');
  assert.match(html, /\.sched-bar \.tp-chip\.lg \{ flex:0 0 auto; min-width:112px; \}/, '时间胶囊按内容宽');
  // 【踩过的坑】行的直接子项是「包胶囊的那两个 div」（胶囊是孙节点）：
  // 把 flex 写在胶囊上不生效，时区胶囊会被 base 样式撑成一根 633px 的长条。
  assert.match(html, /\.sched-bar > #sched-tz \{ display:flex; flex:0 1 auto; min-width:0; \}/, '时区那格是行里的直接子项');
  assert.match(html, /\.sched-bar \.tz-chip \{ flex:0 1 auto; \}/, '时区胶囊按内容宽（不许被拉成长条）');
  // 那三行说明不能丢，只是换成了悬浮气泡
  assert.match(html, /<span class="hint-chip" data-tip="这里是全局签到时间/, '说明收进「💡 说明」气泡');
  assert.doesNotMatch(html, /💡 <b>这里是全局签到时间<\/b>/, '常驻的那段说明要删掉（不然高度又回去了）');
  // 旧结构（上下排 + 固定高度注脚）一概不许回来
  assert.doesNotMatch(html, /\.sched-field \{/, '不再有「标签 + 胶囊」叠成一列的结构');
  assert.doesNotMatch(html, /\.sched-tip \{/, '固定高度的那条注脚一并清掉');
  // 卡片本身也收一收（只有一行控件的卡片按普通内边距会显得空）
  assert.match(html, /\.sched-card \{ padding:14px 18px; \}/, '全局签到卡的内边距要单独收一点');
  // 这一行右边剩下的空间给「面板出口连通性」（小圆点），它必须是这一行的子项、贴右边
  assert.match(html, /\.net-strip \{ margin-left:auto;/, '连通性那条要填在这一行右边的空位里');
  assert.match(html, /<div class="net-strip" id="net-strip"/, '要在全局签到卡里（不是另开一张卡）');
  // 外壳要和时间/时区那两颗胶囊**一模一样**：同高 38px、同圆角 --radius-sm、同底色 --card2。
  // （第一版写成了 27px 高的 999px 小药丸，一行里四个块看着就不是一套控件。）
  assert.match(html, /height:38px; padding:0 14px; border:1px solid var\(--line\); border-radius:var\(--radius-sm\);/,
    '连通性那一条要和胶囊同尺寸、同圆角、同描边');
  assert.match(html, /background:var\(--card2\); cursor:pointer; user-select:none;/, '底色也要和胶囊一致');
  assert.doesNotMatch(html, /border-radius:999px;\n\s*background:rgba\(255,255,255,\.03\); cursor:pointer/, '旧的「小药丸」写法不许回来');
  assert.match(html, /\.sched-bar \.tp-chip\.lg, \.sched-bar \.tz-chip \{\n\s*height:38px;/, '胶囊也是 38px（两边要对得上）');
});

t('粘贴区是一个像样的默认框（5 行 + 等宽 + 自动长高 + 清空 + 实时体检）', () => {
  assert.match(html, /<textarea id="ck-paste" rows="5"/, '粘贴框默认 5 行');
  assert.match(html, /\.paste-box textarea \{ margin:0; min-height:104px; max-height:280px/, '粘贴框有最小/最大高度');
  assert.match(html, /function autoGrowPaste\(\)/, '粘贴框要能自动长高');
  assert.match(html, /<button class="ghost sm" id="btn-ck-clear" type="button">清空<\/button>/, '有清空按钮');
  assert.match(html, /<div id="ck-live" class="paste-live">/, '粘贴框下面有实时体检行');
  assert.match(html, /addEventListener\('input', \(\) => \{ autoGrowPaste\(\); refreshPasteState\(\); \}\)/, '输入时实时体检');
  assert.match(html, /<button id="btn-parse-paste" type="button" disabled>/, '粘贴框空着时保存按钮是禁用的');
});

t('保存前的逻辑性体检：硬错误拦住、域名对不上先确认', () => {
  assert.match(html, /function pasteCheck\(info\)/, '要有 pasteCheck');
  assert.match(html, /function refreshPasteState\(\)/, '要有即时状态刷新');
  assert.match(html, /if \(chk\.level === 'bad'\) \{/, '硬错误要拦住');
  assert.match(html, /return pasteFail\(new Error\(\(bad && bad\.title\)/, '硬错误要给出可读原因');
  assert.match(html, /chk\.mismatch && chk\.siteId[\s\S]{0,220}openCookieApplyDialog/, '域名与站点对不上要让人确认一次');
  assert.match(html, /catch \(e\) \{ return pasteFail\(e\); \}/, '解析失败要走 pasteFail');
  assert.match(html, /function pasteFail\(e, detail\)/, 'pasteFail 要能带一句「怎么修」');
});

t('保存路径只有一条：按钮 / 粘贴 / 解析器都走 applyPaste', () => {
  assert.match(html, /async function applyPaste\(\)/, '要有 applyPaste');
  assert.match(html, /\$\('btn-parse-paste'\)\.onclick = \(\) => \{ applyPaste\(\); \};/, '保存按钮要调到 applyPaste');
  assert.match(html, /\$\('ck-paste'\)\.value = raw;[\s\S]{0,220}applyPaste\(\);/, '「填到上面并保存」也要走 applyPaste');
  assert.match(html, /const st = refreshPasteState\(\);\n\s*if \(st && st\.chk\.level !== 'bad'\) applyPaste\(\);/, '粘贴后自动体检 + 自动保存');
});

t('保存成功才清空粘贴框（避免误点又存一遍）', () => {
  assert.match(html, /const saved = await autoApplyCookies\(/, '要拿到「真的写进去了」的结果');
  assert.match(html, /if \(saved\) clearPasteBox\(\);/, '只有成功才清空');
  assert.match(html, /if \(!s\) \{ toast\('未知站点'\); return false; \}/, 'autoApplyCookies 失败路径返回 false');
  assert.match(html, /showExtApplied\(s, d, \{ names, ls, actionText, accountId \}\);\n  return true;/, '成功路径返回 true');
});

t('加完账号指给你看是哪一行（打通流程的最后一步）', () => {
  assert.match(html, /function flashRow\(accountId\)/, '要有 flashRow');
  assert.match(html, /tbody tr\.row-flash \{ animation:rowFlash/, '要有闪烁样式');
  assert.match(html, /<button class="ghost" id="ext-goto">去账号列表看这一行<\/button>/, '弹窗里要有「去看这一行」');
  assert.match(html, /flashRow\(info\.accountId\)/, '按钮要真的滚过去闪一下');
});

t('扩展送来的交接码：内容是拿到手之后才抹掉地址栏里的短码', () => {
  const at = html.indexOf("const mh = (location.hash || '').match(/#handoff=");
  assert.ok(at > 0, '找不到交接码分支');
  const seg = html.slice(at, at + 1400);
  assert.ok(!/history\.replaceState/.test(seg.split('const d0 =')[0] || ''),
    '取回成功之前不该先抹掉短码（否则网络一抖就没法重试）');
  assert.match(seg, /if \(!sid0\) return openCookieSitePicker/, '认不出站点要让人选');
  assert.match(seg, /pasteCheck\(\{ \.\.\.d0, siteId: sid0 \}\)\.mismatch/, '交接码路径也要做域名比对');
});

t('体检函数有单测，也真的被页面用上（旧缓存没有它时也不能把流程弄挂）', () => {
  assert.match(tools, /function checkPastedCreds\(info\)/, 'cookie-tools.js 里要有 checkPastedCreds');
  assert.match(tools, /globalThis\.checkPastedCreds = checkPastedCreds;/, '要挂到全局给页面用');
  assert.match(html, /checkPastedCreds\(info\)/, '页面要真的调用它');
  assert.match(html, /typeof checkPastedCreds === 'function'/, '旧缓存没有它时要能降级');
});

t('卡片标题行统一（不再各写各的 inline style）', () => {
  assert.match(html, /\.card-head \{ display:flex; align-items:center; justify-content:space-between; gap:10px; margin:0 0 12px; \}/,
    '要有统一的 .card-head');
  assert.match(html, /\.card-head > h2 \{ margin:0; \}/, '.card-head 里的 h2 不要再吃第一块的下边距');
  assert.ok((html.match(/class="card-head"/g) || []).length >= 3, '标题行都得用 .card-head');
  assert.doesNotMatch(html, /style="justify-content:space-between;margin-bottom:12px;\">\s*\n\s*<h2>/, '不该再有 inline 的标题行');
});

t('页面上「签到时间」一律叫「全局签到」（含加载中 / 失败 / 空表兜底文案）', () => {
  assert.doesNotMatch(html, /自动签到时间/, '不该再有「自动签到时间」这个说法');
  assert.match(html, /id="sched-line">全局签到时间加载中…</, '顶部加载中文案');
  assert.match(html, /\$\('sched-line'\)\.textContent = '全局签到时间加载失败'/, '失败文案');
  assert.match(html, /全局签到时间在下面「全局签到」卡片里改/, '空表兜底文案要指到「全局签到」卡片');
});

t('添加/更新账号：保存前先体检，硬错误拦在请求之前', () => {
  assert.match(html, /<div id="f-check" class="form-check hidden"><\/div>/, '弹窗里要有体检行');
  assert.match(html, /function checkAccountForm\(\)/, '要有 checkAccountForm');
  assert.match(html, /function renderFormCheck\(st\)/, '要有 renderFormCheck');
  const at = html.indexOf("$('btn-save').onclick");
  const seg = html.slice(at, at + 1200);
  assert.ok(at > 0 && seg.indexOf('renderFormCheck(checkAccountForm())') > 0, '保存要先体检');
  assert.ok(seg.indexOf("st.level === 'bad'") > 0 && seg.indexOf('return;') > 0, '硬错误要先 return');
  assert.match(seg, /el\.focus\(\); el\.scrollIntoView/, '指出是哪一格并focus过去');
  assert.match(html, /liveFormCheck\(\);\n\}/, '打开弹窗就体检一次');
  assert.match(html, /el\.addEventListener\('input', liveFormCheck\)/, '边填边体检');
  assert.match(html, /标了 \* 的是必填项/, '必填漏填要讲明白');
  assert.match(html, /classList\.add\('field-bad'\)/, '有问题的输入框要描红');
  assert.match(html, /以 http:\/\/ 或 https:\/\/ 开头/, '网址字段要校验协议头');
});

t('添加/更新账号：能自动替人做的事就别让人手填', () => {
  assert.match(html, /function normalizeCookieField\(raw\)/, '要有「整段内容只取 Cookie」的归一化');
  assert.match(html, /const wrapped = \/\(\^\|\\n\)\\s\*\(GET\|POST/, '只对整段请求头/cURL/JSON 动手');
  assert.match(html, /Cookie 框里是整段内容，已自动只取 Cookie 部分/, '自动改了要如实告知');
  assert.match(html, /const name = \$\('f-name'\)\.value\.trim\(\) \|\| \(st\.site \? st\.site\.name : siteId\)/,
    '备注名空着就用站点名兜底');
  assert.match(html, /备注名会自动补成/, '兜底要在体检行里说一声');
});

t('执行路线自动选路：徽章显示「实际路线」，换过路要写出来', () => {
  // 线上事故：糊涂鳄从 CF 直连实测正常，旧版韧「扩展在线就全走中继」把它挤成超时，
  // 面板记失败而网站其实已签 —— 徽章只显示「站点默认」就是在骗人。
  assert.match(html, /try \{ remembered = JSON\.parse\(a\.meta \|\| '\{\}'\)\.exec_route \|\| ''; \} catch/,
    '要做 runner 记下的「上次走通的路线」');
  assert.match(html, /const effRoute = !auto[\s\S]{0,320}?siteLocalExec \? 'relay' : 'server'/,
    '自动模式：先看记下的路线，没记录才用站点默认');
  assert.match(html, /const prefix = auto \? '自动 · ' : '';/, '自动模式的徽章要带「自动 · 」前缀');
  assert.match(html, /const auto = !execOverride;/, '手动覆盖后就不该再标「自动」');
  assert.match(html, /routeNote = m\.route_note \|\| '';/, '要读 meta.route_note');
  assert.match(html, /const routeShow = \/自动改走\|都没成功\/\.test\(routeNote\) \? routeNote : '';/,
    '换路记录只在真的换过路线时才占一行');
  assert.match(html, /class="msg-route"/, '换路记录要有展示位');
  assert.match(html, /\.msg-main, \.msg-raw, \.msg-route'/, '截断判定要把换路记录也算进去');
  // 旧建议是错的（实测直连更快更稳），必须删干净
  assert.doesNotMatch(html, /糊涂鳄对机房 IP 更严格/, '糊涂鳄的旧建议（让我切本地网络）与实测不符');
  // 糊涂鳄一个模块管两个域名，提示必须把「dj 直连正常 / hutue.cn 只能本地网络」都说清楚，
  // 只说一半（曾经只写「直连正常」）就是在误导 hutue.cn 那个账号。
  assert.match(html, /hutue: '糊涂鳄分两个独立站：dj\.hutue\.cn 从 CF 网络直连正常/, '糊涂鳄提示没区分两个域名');
  assert.match(html, /hutue\.cn 在 CF 出口被站点 WAF 整站拦死/, '要写明 hutue.cn 从 CF 出口被整站拦死（实测依据）');
});

t('反馈里不摆英文代码，账号行模板里也不能夹注释（会被当成页面内容）', () => {
  // 用户看到的：日志里那行「网站回馈：网站返回：{"success":false,"message":"…"}」——
  // 主文案已经写着那句话了，再摆一串 JSON 只是占地方 + 看着像报错。
  assert.match(html, /function rawFeedbackLine\(raw, shownMsg\)/, '要有 rawFeedbackLine');
  assert.match(html, /const rawClean = rawFeedbackLine\(a\.last_detail, msgShow\)/, '账号行要用它');
  assert.match(html, /const detailLine = rawFeedbackLine\(r\.detail, r\.message\)/, '运行日志也要用它');
  assert.match(html, /网站回馈：\$\{esc\(detailLine\)\}/, '日志里的网站回馈要用清理后的文本');
  assert.doesNotMatch(html, /网站回馈：\$\{esc\(r\.detail\)\}/, '不能把整串 JSON 直接摆出来');
  assert.match(html, /const rawTip = !rawShow && rawText \?/, '不摆出来时也要留一个悬浮看原文的入口');

  // 曾经踩过：注释写在 `return \`` 的下一行 → 成了模板内容，每行账号都把它渲染成文字
  const at = html.indexOf('tb.innerHTML = accounts.map((a) => {');
  assert.ok(at > 0, '找不到账号行模板');
  const seg = html.slice(at, at + 9000);
  const ret = seg.indexOf('return `');
  assert.ok(ret > 0, '账号行模板里找不到 return `');
  const firstLine = (seg.slice(ret + 'return `'.length).split('\n')[1] || '').trim();
  assert.match(firstLine, /^<tr>/, '账号行模板第一行必须是 <tr>，实际：' + firstLine.slice(0, 40));

  // 这个坑单独立了一条自检（语法检查发现不了：它本来就是合法字符串）
  const checkTool = readFileSync(join(root, 'tools', 'check-template-comments.mjs'), 'utf8');
  assert.match(checkTool, /模板字符串里出现了/, '自检工具要能报出泄漏');
  const verifySrc = readFileSync(join(root, 'tools', 'verify.mjs'), 'utf8');
  assert.match(verifySrc, /check-template-comments\.mjs/, '自检要接进 verify.mjs');
});

t('浮层自动收起：共用浮层必须认领「当前主人」（否则鼠标还没进浮层就消失）', () => {
  // 线上表现：点开「全局签到」时间胶囊，鼠标还没来得及移进浮层，它就自己收起来了。
  // 根因：时间浮层是**全页面共用一个元素**，而每个胶囊渲染时都直接覆盖
  // pop.onmouseenter —— 鼠标真进了浮层，cancel 清掉的是「别人的」定时器，
  // 当前胶囊那个 320ms 收起定时器照旧到点执行。
  assert.match(html, /const _popOwner = new WeakMap\(\)/, '缺少「这个浮层现在归谁管」的记录');
  assert.match(html, /pop\.onmouseenter = \(\) => \{ const c = _popOwner\.get\(pop\); if \(c\) c\.cancel\(\); \}/,
    '鼠标进浮层时要现查主人、清掉它的定时器（不能绑死在某个胶囊上）');
  assert.match(html, /ctl\.own\(\)/, '打开浮层时要说清「现在归我管」（own）');
  assert.doesNotMatch(html, /\n\s*bindAutoHide\(pop, chip\);/, '不能回到「渲染时就绑定、丢掉返回值」的老写法（后面创建的胶囊会把它覆盖掉）');
  assert.match(html, /const ctl = bindAutoHide\(pop, chip\);/, '浮动层要拿到控制器（好在打开时认领）');
  // 时区浮层同样要有主人概念，否则它的自动收起也会失效
  assert.match(html, /bindAutoHide\(pop, btn\)\.own\(\)/, '时区浮层也要认领');
});

t('自动检查心跳：面板顶部能看出定时到底有没有在跑', () => {
  // 「时间到了却没签到」以前在面板上完全看不出来：心跳把这层补上。
  assert.match(html, /function schedBeatText\(s\)/, '要有心跳文案函数');
  assert.match(html, /自动检查：暂无记录/, '没有任何记录时也要给一句话');
  assert.match(html, /if \(minutes > 45\)/, '超过 45 分钟没记录就要判定为停摆');
  assert.match(html, /⚠️ 自动检查\$\{hours\}/, '停摆要显式告警（含最后一次时间与排查方向）');
  assert.match(html, /paintSchedLine\(s, displayTime\)/, '顶部那行要用它渲染');
  assert.match(html, /setInterval\(async \(\) => \{[\s\S]{0,240}?paintSchedLine\(s, displayTime\)/, '要有只刷心跳的轮询');
  assert.doesNotMatch(html, /setInterval\(.*loadSchedule/, '轮询不能整块重渲染（那会把用户正开着的浮层关掉）');
});

t('执行：面板不许自己把慢请求提前掐断（否则会报一个假的「执行失败」）', () => {
  // 线上后果：点「执行」/「全部执行」，60 秒到点面板自己 abort，弹一句「执行失败」；
  // 而服务端还在跑，站点很可能已经签上了 —— 用户照着提示再点一次，就是第二轮重复请求。
  assert.match(html, /const API_TIMEOUT_MS = 60000;/, '普通请求保留 60 秒默认超时');
  assert.match(html, /const RUN_TIMEOUT_MS = 150000;/, '执行类请求要单独放开超时');
  assert.match(html, /async function api\(path, method = 'GET', data, opts = \{\}\) \{/, 'api 要支持自定义超时');
  assert.match(html, /opts\.timeoutMs/, '超时要能从调用处传进来');
  assert.match(html, /err\.timedOut = true;/, '超时要能识别出来（好说清「不是失败，是没等到」）');
  assert.equal((html.match(/r\.json\(\)\.catch\(\(\) => \(\{\}\)\)/g) || []).length, 0,
    '不能再用 r.json() 吞掉非 JSON 的错误页（524 会变成一句看不懂的「请求失败 524」）');
  assert.match(html, /raw\.trim\(\)\.startsWith\('\{'\)/, '要能分辨「JSON 错误」与「Cloudflare 的 HTML 错误页」');
});

t('执行：单个账号走同一条路径，结果口径完全一致', () => {
  assert.match(html, /async function runOneAccount\(id, btn = null, quiet = false\)/, '要有 runOneAccount');
  assert.match(html, /api\('\/api\/accounts\/' \+ id \+ '\/run', 'POST', undefined, \{ timeoutMs: RUN_TIMEOUT_MS \}\)/, '要用放开后的超时');
  assert.match(html, /tb\.querySelectorAll\('\[data-run\]'\)\.forEach\(\(b\) => \(b\.onclick = \(\) => runOneAccount\(b\.dataset\.run, b\)\)\)/,
    '行内「执行」按钮要调它');
});

t('全部执行：逐账号发请求，不再用一个请求串完全部', () => {
  // /api/run-all 是「一个请求跑完所有账号」：每个账号最坏等 90 秒 →
  // Cloudflare 单个请求约 100 秒上限（回 524）、浏览器 60 秒就断 —— 必然假失败。
  const at = html.indexOf("$('btn-run-all').onclick");
  assert.ok(at > 0, '找不到全部执行的处理器');
  const seg = html.slice(at, at + 2200);
  assert.doesNotMatch(seg, /api\('\/api\/run-all'/, '面板不该再调那个长请求');
  assert.match(seg, /for \(let i = 0; i < list\.length; i\+\+\)/, '要逐账号循环');
  assert.match(seg, /runOneAccount\(a\.id, null, true\)/, '循环里走同一条执行路径（只是不逐条弹提示）');
  assert.match(seg, /执行中… \$\{i \+ 1\}\/\$\{list\.length\}/, '按钮上要能看到进度');
  assert.match(seg, /ACCTS \|\| \[\]\)\.filter\(\(a\) => a\.enabled\)/, '只跑启用的账号');
  assert.match(seg, /api\('\/api\/notify-report'/, '手动跑完仍要推日报（以前挂在 /api/run-all 上）');
  // 推送失败不许影响面板上的结果
  assert.match(seg, /api\('\/api\/notify-report'[\s\S]{0,120}?\.catch\(\(\) => \{\}\)/, '推送失败要静默');
});

t('粘贴长内容不再把页面拉长，旁边不再大片空白', () => {
  // 线上表现：粘一包 Cookie（二十多段）后，分解框一段一行地铺下去，
  // 整页被拉得老高，左边那一栏就成了一大片空白。  assert.match(html, /#ck-preview \{ max-height:min\(40vh, 360px\); overflow-y:auto;/, '粘贴内容分解框要限高 + 内部滚动（而不是把页面撑开）');
  assert.match(html, /#ck-analyze-out \{ max-height:min\(40vh, 360px\); overflow-y:auto;/, 'Cookie 解析器的结果框也要限高');
  assert.match(html, /const MAX_PART_ROWS = 12;/, '段数多时要只铺前几段');
  assert.match(html, /class="ckb-more"><summary>还有 \$\{extraParts\.length\} 段/,
    '剩下的段要折起来，而不是直接铺满整页');
  assert.match(html, /\.ckb-more > summary::before \{ content:"▸ "; \}/, '折叠开关要能看出可以点开');
  // 粘贴分解与 Cookie 解析器的结果都要限高（它们一个横跨整幅、一个在标签页里）
  assert.match(html, /#ck-preview \{ margin-top:16px; max-height:min\(40vh, 360px\)/, '粘贴分解要限高 + 内部滚动');
  assert.match(html, /#ck-analyze-out \{ max-height:min\(40vh, 360px\)/, '解析结果也要限高');
});

t('粘贴区与 Cookie 解析器合并成同一张卡里的两个标签', () => {
  // 两件事都是「把一包 Cookie 贴进来」：粘贴区直接保存，解析器只看不存。
  // 合并到一块地方用标签区分，就不必再去猜该用哪一个、也不会两个框各占一半宽度。
  assert.match(html, /<div class="ck-tabs">\s*\n\s*<button type="button" data-cktab="paste" class="on">/, '默认停在「粘贴即保存」');
  assert.match(html, /data-cktab="analyze">🔍 Cookie 解析器<\/button>/, '第二个标签是解析器');
  assert.match(html, /<div id="ck-pane-paste">/, '粘贴那一块');
  assert.match(html, /<div id="ck-pane-analyze" class="hidden">/, '解析那一块默认藏起来');
  assert.match(html, /function ckShowTab\(name\)/, '要有切换函数');
  assert.match(html, /b\.onclick = \(\) => ckShowTab\(b\.dataset\.cktab\)/, '标签要能点');
  assert.match(html, /const want = name === 'analyze' \? 'analyze' : 'paste';/, '只认这两个值');
  // 解析器里那个「填到粘贴区并保存」：必须先把标签切回去，
  // 否则后面的体检 / 试跑信息都显示在另一个标签页里，用户看不见
  assert.match(html, /ckShowTab\('paste'\);\n\s*\$\('ck-paste'\)\.value = raw;/,
    '填到粘贴区之前要先切回粘贴那个标签');
  assert.match(html, /id="btn-ck-analyze-fill"[^>]*>↗️ 填到粘贴区并保存</, '按钮文案要指向新的位置');
  assert.doesNotMatch(html, /id="ck-analyze-box"/, '不再是折叠块了');
  assert.doesNotMatch(html, /id="btn-ck-analyze-clear"[^>]*>[^<]*$/, '拆解框的清空按钮要绑上事件');
  assert.match(html, /\$\('btn-ck-analyze-clear'\)\.onclick/, '拆解框也要能清空');
  // 标签不能用顶部那个 .tabs（那会把账号/日志/设置三个主标签顶掉）
  assert.match(html, /document\.querySelectorAll\('\.ck-tabs > button'\)/, '切换只作用在 .ck-tabs 上');
  assert.doesNotMatch(html, /class="tabs ck-tabs|class="ck-tabs tabs/, '不能蹭主标签的样式');
});

t('导出我的配置：按「签到网站」选，不再让人先猜用哪个账号', () => {
  // 要分享出去的是「这个网站怎么签到」，别人导入后看到的应该是网站名；
  // 以前按账号选，同名账号一多就得先猜哪个是调通过的那个。
  assert.doesNotMatch(html, /com-export-account/, '不该再有「先选账号」那一个下拉');
  assert.match(html, /<label style="margin-top:0">选择签到网站<\/label>\n\s*<select id="com-export-site"><\/select>/,
    '导出那一块要只有「选择签到网站」');
  assert.match(html, /\$\('com-export-site'\)\.onchange = \(\) => refreshExportSiteHint\(\$\('com-export-site'\)\.value\);/,
    '换了网站要刷新下面的说明');
  assert.match(html, /function refreshExportSiteHint\(site\)/, '要有「这个站下面有几个账号」的说明函数');
  assert.match(html, /const site = \$\('com-export-site'\)\.value;/, '导出按钮要按网站取值');
  assert.match(html, /const picks = exportableAccounts\(\)\.filter\(\(a\) => a\.site === site\);/, '要取出这个站下的账号');
  assert.match(html, /for \(const a of picks\) \{[\s\S]{0,320}?one = await api\('\/api\/accounts\/' \+ a\.id \+ '\/export-config/,
    '一个站多个账号时逐个试（有的账号还没录任务，导不出东西）');
  assert.match(html, /function showComOut\(\)/, '导出的结果要有一个统一的「摊开」入口');
  assert.match(html, /\$\('com-out-wrap'\)\.classList\.remove\('hidden'\);/, '摊开的是外层容器（而不是只改那个 textarea）');
});

t('社区站点（开源共享）在设置页里，不再占着账号页', () => {
  assert.ok(html.indexOf('id="card-community"') > html.indexOf('id="tab-settings"'),
    '社区站点卡片要在设置页的 tab 里面');
  assert.ok(html.indexOf('id="card-community"') < html.indexOf('</section>', html.indexOf('id="tab-settings"')),
    '社区站点卡片要在设置页 section 结束之前');
  assert.equal((html.match(/id="card-community"/g) || []).length, 1, '只能有一份（不能克隆出两个同 id）');
  assert.match(html, /设置[\s\S]{0,4000}?id="card-community"/, '应该能在设置页里找到它');
});

t('社区站点的「来源」链接只认 http(s)（esc 拦不住 javascript: 协议）', () => {
  // <a href="${esc(s.source)}"> 里，esc 只转义引号尖括号，管不了协议：
  // javascript:fetch('/api/ext-key/rotate',{method:'POST'}) 转义后依旧是个能点的链接，
  // 点一下就在面板的源（带着管理员会话）里执行脚本。而 source 是别人写在配置里的。
  assert.match(html, /function safeHref\(u\)/, '要有一个只放行 http/https 的 href 工具函数');
  assert.match(html, /function safeHref\(u\) \{[\s\S]{0,200}?esc\(s\) : ''/, 'safeHref 只放行 http/https（其余一律不给链接）');
  assert.match(html, /href="\$\{safeHref\(s\.source\)\}"/, '来源链接必须走 safeHref，而不是直接 esc');
  assert.doesNotMatch(html, /href="\$\{esc\(s\.source\)\}"/, '旧的直接 esc 写法不许回来了');
});

t('网站反馈里的建议不进表格：只留一枚「💡 建议」，完整内容悬浮才弹', () => {
  // 以前建议是常驻的两行小字（💡 开头，能把表格撑高）——
  // 一列账号十行建议，扫一眼全是小字，真正要看的「网站说了什么」反而被淹。
  // 现在正文一个字都不显示，只剩一枚胶囊（鼠标移上去弹完整内容）。
  assert.match(html, /<span class="hint-chip" data-tip="\$\{esc\(hintText\)\}">💡 建议<\/span>/, '建议要收进悬浮胶囊');
  assert.doesNotMatch(html, /class="hint-tip"/, '常驻的建议正文要删干净');
  assert.doesNotMatch(html, /hintShow/, '不再有「显示用建议文本」这回事');
  // 胶囊自己没有可展开的正文，不该再进「展开全文」的判定（否则点开了也看不到东西）
  assert.match(html, /const parts = \[\.\.\.cell\.querySelectorAll\('\.msg-main, \.msg-raw, \.msg-route'\)\];/,
    '「展开全文」只算真正被截断的三行');
  assert.match(html, /\.hint-chip \{ display:inline-block;/, '胶囊要有自己的样式（不能靠旧类名）');
});

t('站点那一格的小控件外框一模一样（同高、同圆角、同描边）', () => {
  // 【实测过的旧值】网络徽章 22px 高、无描边；随机/固定分段器 26.7px 高、弧度 999px、带 1px 描边；
  // 切换按钮 30px 高。几个叠在同一格里，高低不平、弧度不一，看着就是几个尺寸不一的东西凑在一起。
  assert.match(html,
    /\.site-wrap \.badge,\n\s*\.site-wrap \.seg,\n\s*\.site-wrap \.exec-switch,\n\s*\.site-wrap \.pill \{\n\s*height:24px; box-sizing:border-box; padding:0 10px; margin:0;/,
    '四个小控件要共用一条尺寸规则');
  assert.match(html, /border:1px solid transparent; border-radius:var\(--radius-xs\);\n\s*font-size:11\.5px; line-height:1; flex-shrink:0; \}/,
    '同描边、同圆角、同字号');
  assert.doesNotMatch(html, /border-radius:999px; overflow:hidden; margin:0; width:100%/, '分段器不再另起一套弧度');
  assert.doesNotMatch(html, /\.exec-switch \{ font-size:11px !important; padding:3px 10px !important/, '切换按钮不再自带一套内边距/字号');
  // 竖着排的那几个要占满整格宽；切换按钮在「名字 + 社区徽章 + 切换」那一行里，拉满会把名字挤出去
  assert.match(html, /\.site-wrap \.badge, \.site-wrap \.seg, \.site-wrap \.pill \{ width:100%; \}/, '竖着排的要占满整格宽');
  assert.doesNotMatch(html, /\.site-wrap \.exec-switch \{ width:100%/, '切换按钮不能拉满整格宽');
});

t('表头「网站反馈」也居中（和其他表头对整齐）', () => {
  assert.match(html, /<th class="c">网站反馈<\/th>/, '没加 .c 它就会是唯一一个左对齐的表头');
  assert.match(html, /<thead><tr><th class="c">站点<\/th><th class="c">全局签到<\/th><th class="c">状态<\/th><th class="c">网站反馈<\/th>/,
    '一整行表头都要居中');
});

t('全局签到：选好即保存，没有「保存」按钮', () => {
  // 【为什么要删按钮】时间胶囊选完即生效、时区浮层点中即收起 —— 两个控件本身就是「点一下确定」。
  // 再要求去右上角点一次「保存」，就会出现「我选好了怎么没生效」（其实没写库）。
  assert.doesNotMatch(html, /btn-save-sched/, '按钮（含 CSS 与 onclick）要删干净');
  assert.match(html, /选好即保存/, '卡头要写清「不用再点按钮」');
  // 两个控件都要能通知“变了”：tp-change 本来就有，时区这次补上
  assert.match(html, /container\.dispatchEvent\(new CustomEvent\('tz-change', \{ bubbles: true \}\)\)/, '时区选完要派发 tz-change');
  assert.match(html, /\$\('sched-tp'\)\.addEventListener\('tp-change', queueSaveSchedule\)/, '时间胶囊要接自动保存');
  assert.match(html, /\$\('sched-tz'\)\.addEventListener\('tz-change', queueSaveSchedule\)/, '时区也要接自动保存');
  // 防抖：滚轮每滚一格都会派发 tp-change，不防抖从 08:00 滚到 09:00 就是 60 次 PUT
  assert.match(html, /const queueSaveSchedule = \(\) => \{ clearTimeout\(schedSaveTimer\); schedSaveTimer = setTimeout\(saveSchedule, 400\); \}/,
    '自动保存必须防抖');
  // 没真的变就不写库（点开浮层又原样关掉）；写失败要刷回服务端的值
  assert.match(html, /if \(v === SCHED_SAVED\.time && tz === SCHED_SAVED\.tz\) return;/, '没变就别白写一次');
  assert.match(html, /await loadSchedule\(\); \/\/ 写失败就刷回服务端的值/, '写失败不能留在「以为改了」的状态');
  // 保存后要同步账号列表（“跟随全局”的那几行显示的时间要立刻跟上）
  assert.match(html, /await loadSchedule\(\);[\s\S]{0,200}?await loadAccounts\(\);[\s\S]{0,120}?toast\('已保存：全局签到 '/,
    '保存完要刷新全局时间 + 账号列表并给确认提示');
});

t('鼠标悬浮站点名 → 弹出凭据到期时间', () => {
  // 用户最容易卡在「我明明更新了 Cookie，怎么还说失效」——而很多站点把到期时间就写在凭据里
  // （WordPress 会话写在 cookie 值里， Akile 的 akile-token 是 JWT）。
  // 悬浮站点名直接告诉他「这份还能撑到什么时候」，比等签到失败再查快得多。
  assert.match(html, /<b class="site-name" data-tip="\$\{esc\(credExpTip\(a\.cred_exp, a\.meta\)\)\}">\$\{esc\(a\.name\)\}<\/b>/,
    '站点名要挂气泡（带账号 meta，好展示自动续期状态）');
  assert.match(html, /function credExpTip\(exp, metaStr\)/, '要有 credExpTip');
  assert.match(html, /const s = \(exp && exp\.sessions\) \|\| \[\];/, '要读服务端解出的 sessions');
  assert.match(html, /const t = \(exp && exp\.tokens\) \|\| \[\];/, '也要读 tokens（如 akile-token）');
  assert.match(html, /const lines = \[s\.length \? 'Cookie 有效期' : '凭据到期时间'\];/, '有 Cookie 会话就叫「Cookie 有效期」，只有 token 时才叫「凭据到期时间」');
  assert.match(html, /这份 Cookie \/ 凭据里没有写到期时间/, '凭据里确实没写时要如实说（不能猜一个时间出来）');
  assert.match(html, /自动续期：上次成功/, '自动续期成功要在悬浮提示里写出来');
  assert.match(html, /自动续期失败/, '自动续期失败要在悬浮提示里写出来（带原因和重试说明）');
  // 不依赖后端：这一格是 a.cred_exp（服务端只回结论、不回凭据）；
  // 拖不动的时候连提示都没了，所以要有一条点线底线作暗示
  assert.match(html, /\.site-head b\.site-name \{ cursor:help; border-bottom:1px dotted/, '点线底线是可悬浮的唯一暗示');
});

t('扩展「录制签到」回填：必须先 openModal 再选「自定义 HTTP」站点', () => {
  // 【线上真 bug，2026-09-30】applyRecordDraft 以前是反的：先 $('f-site').value='http'，
  // 再 await openModal()。但 openModal 里 renderModalSites() 会重建站点下拉框，
  // 在它之前设的值会被吞掉（下拉框那时可能还是空的）→ 表单错渲染成第一个站点
  // （夸克网盘），录制的 url / method / headers 全填不进去还静默丢失，
  // 用户只看到一个备注名对、站点错的表单：「站点没有自动选择适配」。
  const m = html.match(/async function applyRecordDraft\(d\) \{([\s\S]*?)\n\}/);
  assert.ok(m, '要找得到 applyRecordDraft');
  const body = m[1];
  const openIdx = body.indexOf('await openModal()');
  const siteIdx = body.indexOf("$('f-site').value = 'http'");
  assert.ok(openIdx !== -1 && siteIdx !== -1, '两行都要在');
  assert.ok(openIdx < siteIdx, '必须先 openModal()，再设 f-site 为 http（反了会被 renderModalSites 吞掉）');
  assert.match(body, /renderFields\('http', \{\}\)/, '设完站点要重渲染字段，不然还是旧站点的表单');
});

console.log(`\n${n} 通过`);
