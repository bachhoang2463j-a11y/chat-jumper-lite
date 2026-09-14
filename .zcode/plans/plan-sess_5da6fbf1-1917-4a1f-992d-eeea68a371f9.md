# 修复「区间末尾为 AI 楼时向下滑动不补齐」——方案 A：scroll 位置驱动兜底

## 根因（已实证）
末尾 AI 楼的代码块被酒馆助手渲染为 iframe，覆盖整个底部 300px 触发区；wheel/触屏事件在 iframe 内部派发、永不冒泡到父页面，`#chat` 上的监听器收不到滚动意图。浏览器滚动链仍会滚动 `#chat` 并派发 `scroll` 事件，故改用 scroll 位置驱动兜底。

## 冲突确认结论（已探查源码）
- **cocktail**：自动补齐被 `#show_more_messages` 按钮存在性单一门控，区间重建后按钮不存在 → 全部短路，无冲突；隐藏代码块为纯 CSS，对新插楼自动生效。
- **ST-BaiBai-Tools**：content-visibility 优化不增删 DOM，补齐阶段无冲突；恢复时强制滚底与酒馆原生行为一致，不处理。

## 步骤

### 1. 改码前实测（排障模式真 Chrome，用户已复现的会话）
先刷新页面使旧脚本实例的 `rangeActive` 复位，注入一次性探针脚本：
- 监听 `scroll` → 贴底（≤300px）时 `addOneMessage` 追加 5 楼 + 补发渲染事件；
- 记录补齐前后 `scrollTop`、视口首楼 `rect.top` 漂移量 → **判定视口是否错位**；
- 端到端验证：光标停在代码块 iframe 上滚动时，scroll 兜底确实触发补齐；
- 顺带确认区间模式期间 `#chat` 内无 `#show_more_messages`（若有，改动 2 中加一行防御移除）。

### 2. jump-lite.js 增加 scroll 兜底（核心改动，约 +30 行）
- 新增模块级状态 `lastScrollTop = null`；
- 新增 `onScroll()`：
  - `rangeActive || filling` 守卫；读 `getScrollEl()`；
  - `delta = scrollTop - lastScrollTop`（忽略 <1px），方向门控：`delta > 0` 且距底 ≤ `EDGE_THRESHOLD` → `fillEdge('down')`；`delta < 0` 且 `scrollTop ≤ EDGE_THRESHOLD` → `fillEdge('up')`；
  - **冷却死角兜底**：贴边但处于 250ms 冷却期内时，安排一次性 `setTimeout(COOLDOWN_MS + 30)` 复查边缘条件再补——防止"一甩到底落在冷却窗口内、停在底部后无 scroll 事件可用"的二次冻结；
  - 方向门控天然排除程序性滚动：跳转定位（向下滚）只查贴底、向上补齐的补偿写入在 `filling` 锁内、尾随 scroll 事件被冷却拦下。
- `attachAutoFill()` 挂 `scroll`（passive），`detachAutoFill()` 摘除并重置 `lastScrollTop = null`；
- 保留现有 wheel/touch 处理（即时响应路径不变）。
- 若步骤 1 实测发现向下补齐视口漂移：将 `insertInRafChunks` 的补偿从 `scrollHeight` 差值改为锚元素 contentTop 差值（参照 cocktail）；无漂移则不动。

### 3. harness.html 增加 scroll 路径回归用例
- T8：滚动到底后 dispatch `scroll` 事件（无 wheel）→ 验证向下补齐 5 楼；顶部 dispatch `scroll`（向上方向）→ 验证向上补齐；验证冷却兜底路径与 `MORE_MESSAGES_LOADED` 仍正常补发。
- 运行全部用例通过。

### 4. 打包与校验
- `node --check jump-lite.js` 语法校验；
- 同步更新 `酒馆助手脚本-跳转楼层ChatJumperLite.json` 内的脚本正文；
- 排障模式真 Chrome 注入新版做端到端验证（scroll 触发补齐、iframe 上滚动有效、cocktail/BaiBai 共存无异常）；
- git 提交并备注短 hash。

## 不做的事（手术式边界）
- 不动恢复逻辑（BaiBai 滚底与原生一致）；
- 不动向上补齐现有补偿（当前无问题，仅实测记录）；
- 不加推测性的 pre 封顶/高度冻结（用户已有 cocktail 折叠 CSS，实测无感知跳变就不加）。