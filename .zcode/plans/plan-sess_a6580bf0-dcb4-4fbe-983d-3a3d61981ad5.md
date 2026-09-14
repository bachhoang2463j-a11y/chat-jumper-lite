## 移植方案：补发楼层渲染事件，保证 iframe 代码块渲染

### 背景

chat_tump 的修复机制（index.js:1959-1988 `notifyFloorsRendered`）：`addOneMessage` 不走酒馆正常渲染管线（不发事件），渲染类扩展（酒馆助手 JS-Slash-Runner）完全靠 `USER/CHARACTER_MESSAGE_RENDERED` 事件驱动 iframe 挂载。不发事件时其 runtime 记录仍指向被 `replaceChildren` 销毁的旧 DOM，楼层内组件 iframe 不会重建，用户看到裸代码块。楼层级事件处理器会先剔除失效 runtime 再重扫 DOM，因此逐楼补发即可恢复 iframe 渲染。

本项目 `jump-lite.js` 的跳转（L153-156）和滑动补齐（L194）都用 `addOneMessage` 插楼但从不补发事件——症状与 chat_tump 修复前完全一致。

### 改动内容（全部在 D:\Project\chat-jumper-lite）

**1. `jump-lite.js` 新增帮助函数**（放在「区间重建跳转」区块之前，注释沿用 chat_tump 的原理解释）：

```js
function notifyFloorsRendered(chat, ids) {
    const ctx = getCtx();
    const eventSource = ctx?.eventSource;
    const types = ctx?.eventTypes;
    if (!eventSource || !types?.USER_MESSAGE_RENDERED || !types?.CHARACTER_MESSAGE_RENDERED) return;
    for (const id of ids) {
        const type = chat[id]?.is_user ? types.USER_MESSAGE_RENDERED : types.CHARACTER_MESSAGE_RENDERED;
        try {
            void eventSource.emit(type, id);
        } catch { /* 事件接口异常则跳过该楼 */ }
    }
}
```

**2. `jumpTo`（L153-156 之后）**：循环插楼后调用 `notifyFloorsRendered(chat, 区间内全部 id)`。

**3. `fillEdge`（L246 之后）**：`await insertInRafChunks(...)` 完成、在现有 `MORE_MESSAGES_LOADED` emit 之前，调用 `notifyFloorsRendered(chat, ids)`——向上/向下补齐的批次 id 由此处的 ids 数组直接给出，`insertInRafChunks` 本身不动。

**4. `harness.html` 增强**：Mock 的 SillyTavern context 补上 `eventSource.emit`（spy 记录调用）与 `eventTypes`（USER/CHARACTER_MESSAGE_RENDERED）；新增测试 T7 断言跳转和上下补齐后每楼都补发了正确类型的渲染事件。

### 验证流程

1. `node --check jump-lite.js` 语法校验。
2. IAB 打开 `harness.html` 跑全部测试（T1-T7），确认新逻辑不破坏既有补齐/滚动行为。
3. 真实酒馆环境（iframe 是否真的重新挂载）依赖酒馆助手运行时，属于需要用户实机确认的部分，完成后等待用户导入测试反馈。

### 收尾

- 用 node 脚本重新生成 `酒馆助手脚本-跳转楼层ChatJumperLite.json`（嵌入新版 jump-lite.js，保留其余字段与说明信息）。
- README 补一行功能说明。
- git 提交备份并在会话中备注短 hash。