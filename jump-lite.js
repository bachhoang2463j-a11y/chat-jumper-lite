// =====================================================================
// 跳转楼层 Chat Jumper Lite
// 形态：酒馆助手（TavernHelper）脚本库 → 全局脚本
// 功能：扩展抽屉入口 → 输入楼层号 → 区间重建（目标楼 + 后续 4 楼共 5 楼）
//       → 滑动到窗口边缘自动分帧补齐（每批 5 楼）→ 弹窗内可恢复完整显示
// 参考：ST-Chat-Jumper（区间重建）、cocktail（rAF 分帧 + 视口补偿）
// =====================================================================

(function () {
    'use strict';

    // ------------------------- 常量 -------------------------
    const WINDOW_SIZE = 5;        // 跳转时初始窗口楼数（目标楼 + 后续 4 楼）
    const BATCH_SIZE = 5;         // 滑动补齐每批楼数
    const PER_FRAME = 3;          // 每帧插入楼数（rAF 分帧）
    const EDGE_THRESHOLD = 300;   // 距边缘多少像素内视为“贴边”
    const COOLDOWN_MS = 250;      // 两批补齐之间的最小间隔
    const WAIT_EL_TIMEOUT = 2000; // 等待目标楼层 DOM 出现的超时
    const BUTTON_ID = 'stcj-lite-button';
    const STYLE_ID = 'stcj-lite-style';
    const FLASH_CLASS = 'stcj-lite-flash';

    // ------------------------- 状态 -------------------------
    let rangeActive = false;      // 区间显示模式是否激活（决定是否自动补齐）
    let filling = false;          // 补齐批次进行中（锁）
    let lastFillTs = 0;           // 上次补齐时间（冷却）
    let touchStartY = null;       // 触屏方向探测
    let lastScrollTop = null;     // scroll 兜底的方向基线（null = 未建立）
    let scrollRecheckTimer = null; // 冷却死角的一次性复查定时器
    let cleanupFns = [];          // pagehide / 脚本重载时的清理回调

    // ------------------------- 基础工具 -------------------------
    const doc = () => window.parent.document;
    const getCtx = () => window.parent.SillyTavern?.getContext?.() ?? null;

    function getChatEl() {
        return doc().getElementById('chat');
    }

    // 滚动容器：#chat 外层的 SimpleBar wrapper，绝不动 window 滚动
    function getScrollEl() {
        const chat = getChatEl();
        if (!chat) return null;
        return chat.closest('.simplebar-content-wrapper')
            || chat.querySelector('.simplebar-content-wrapper')
            || chat;
    }

    function clamp(v, min, max) {
        return Math.max(min, Math.min(max, v));
    }

    function idsInRange(start, end) {
        const ids = [];
        for (let i = start; i <= end; i++) ids.push(i);
        return ids;
    }

    // 从 DOM 实时读取当前已显示窗口边界，不维护易漂移的状态
    function getDisplayedRange() {
        const mesList = getChatEl()?.querySelectorAll(':scope > .mes');
        if (!mesList || mesList.length === 0) return null;
        const first = Number(mesList[0].getAttribute('mesid'));
        const last = Number(mesList[mesList.length - 1].getAttribute('mesid'));
        if (!Number.isFinite(first) || !Number.isFinite(last)) return null;
        return { first, last };
    }

    function toast(message, type = 'info') {
        const toastr = window.parent.toastr;
        if (toastr && typeof toastr[type] === 'function') toastr[type](message);
        else console.log(`[跳转楼层] ${message}`);
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // 轮询等待目标楼层 DOM 出现（虚拟滚动 / 重建后渲染需要时间）
    async function waitForMessageEl(mesId, timeout) {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            const el = getChatEl()?.querySelector(`:scope > .mes[mesid="${mesId}"]`);
            if (el) return el;
            await sleep(50);
        }
        return null;
    }

    // ------------------------- 样式 -------------------------
    function ensureStyle() {
        const d = doc();
        if (d.getElementById(STYLE_ID)) return;
        const style = d.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
@keyframes stcjLiteFlash {
    0%, 100% { box-shadow: none; }
    25%, 75% { box-shadow: 0 0 0 3px var(--SmartThemeQuoteColor, #f5a623); }
}
.${FLASH_CLASS} { animation: stcjLiteFlash 0.9s ease 1; }
`;
        d.head.appendChild(style);
        cleanupFns.push(() => style.remove());
    }

    function flashMessage(el) {
        if (!el) return;
        el.classList.remove(FLASH_CLASS);
        // 强制 reflow 让动画可重复触发
        void el.offsetWidth;
        el.classList.add(FLASH_CLASS);
        setTimeout(() => el.classList.remove(FLASH_CLASS), 950);
    }

    // ------------------------- 滚动定位 -------------------------
    // 只滚聊天容器，把目标楼对齐视口顶部
    function scrollMessageToTop(el, behavior = 'auto') {
        const scrollEl = getScrollEl();
        if (!el || !scrollEl) return;
        const vp = scrollEl.getBoundingClientRect();
        const rect = el.getBoundingClientRect();
        const max = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
        const target = clamp(scrollEl.scrollTop + rect.top - vp.top, 0, max);
        if (typeof scrollEl.scrollTo === 'function') {
            scrollEl.scrollTo({ top: target, behavior });
        } else {
            scrollEl.scrollTop = target;
        }
    }

    // ------------------------- 楼层渲染事件补发 -------------------------
    // addOneMessage 不走酒馆正常渲染管线（不发任何事件），而渲染类扩展
    // （如酒馆助手 JS-Slash-Runner）完全靠 USER/CHARACTER_MESSAGE_RENDERED
    // 事件驱动 iframe 挂载：不发事件时，其内部 runtime 记录仍指向已被
    // replaceChildren 销毁的旧 DOM 节点，楼层内的前端组件（iframe）不会
    // 被重建，用户会看到裸露的代码块。
    // 楼层级事件的处理逻辑会先剔除该楼层的失效 runtime 再重扫 DOM，
    // 因此逐楼补发即可恢复 iframe 渲染（与正常打印楼层时的行为一致）。
    function notifyFloorsRendered(chat, ids) {
        const ctx = getCtx();
        const eventSource = ctx?.eventSource;
        const types = ctx?.eventTypes;
        if (!eventSource || !types?.USER_MESSAGE_RENDERED || !types?.CHARACTER_MESSAGE_RENDERED) return;

        for (const id of ids) {
            const type = chat[id]?.is_user ? types.USER_MESSAGE_RENDERED : types.CHARACTER_MESSAGE_RENDERED;
            try {
                void eventSource.emit(type, id);
            } catch {
                /* ignore */
            }
        }
    }

    // ------------------------- 区间重建跳转 -------------------------
    async function jumpTo(floorInput) {
        const ctx = getCtx();
        const chat = Array.isArray(ctx?.chat) ? ctx.chat : null;
        if (!chat || chat.length === 0) {
            toast('当前聊天为空', 'warning');
            return;
        }
        const maxId = chat.length - 1;
        const target = clamp(Math.floor(Number(floorInput)), 0, maxId);
        if (!Number.isFinite(target)) {
            toast('请输入有效的楼层号', 'error');
            return;
        }

        const chatEl = getChatEl();
        if (!chatEl || typeof ctx.addOneMessage !== 'function') {
            toast('当前环境不支持楼层渲染接口', 'error');
            return;
        }

        // 防止重建过程被酒馆自动滚到底
        const power = ctx.powerUserSettings;
        const prevAutoScroll = power?.auto_scroll_chat_to_bottom;
        if (power) power.auto_scroll_chat_to_bottom = false;

        const start = target;
        const end = Math.min(target + WINDOW_SIZE - 1, maxId);

        // 区间重建清空 #chat 会把 scrollTop 钳到 0 并派发 scroll 事件：
        // 先重置方向基线并取消待复查，避免被误判为“向上滚动”而立即向上补齐
        resetScrollTracking();

        chatEl.replaceChildren();
        for (let i = start; i <= end; i++) {
            ctx.addOneMessage(chat[i], { forceId: i, scroll: false, showSwipes: false });
        }
        notifyFloorsRendered(chat, idsInRange(start, end));
        rangeActive = true;
        attachAutoFill();

        await sleep(50);
        const targetEl = await waitForMessageEl(target, WAIT_EL_TIMEOUT);
        if (targetEl) {
            scrollMessageToTop(targetEl);
            flashMessage(targetEl);
            toast(`已跳转到第 ${target} 楼（显示 ${start}-${end}，上下滑动可加载更多）`);
        } else {
            const scrollEl = getScrollEl();
            if (scrollEl) scrollEl.scrollTop = target <= 0 ? 0 : scrollEl.scrollHeight;
            toast(`已显示楼层区间 ${start}-${end}，但未能定位高亮目标楼`, 'warning');
        }
        // 定位滚动同样会派发 scroll 事件（钳位后常为向上），重置基线
        // 避免被当作“用户向上滚动”而在跳转后立即触发补齐
        resetScrollTracking();

        if (power) power.auto_scroll_chat_to_bottom = prevAutoScroll;
    }

    // ------------------------- 滑动自动补齐 -------------------------
    // 每帧最多插 PER_FRAME 条，向上补齐时逐帧补偿 scrollTop 保持视口不跳
    function insertInRafChunks(ctx, ids, insertBeforeFirst) {
        return new Promise(resolve => {
            const chatEl = getChatEl();
            const scrollEl = getScrollEl();
            const upward = insertBeforeFirst; // 向上补齐需要视口补偿
            let index = 0;
            let cursor = insertBeforeFirst; // insertBefore 指针：始终插在“最新插入的那条”之前
            const prevOverflowAnchor = chatEl.style.overflowAnchor;
            if (upward) chatEl.style.overflowAnchor = 'none';

            const step = () => {
                const prevHeight = upward && scrollEl ? scrollEl.scrollHeight : 0;
                let processed = 0;
                while (index < ids.length && processed < PER_FRAME) {
                    const id = ids[index];
                    const options = { forceId: id, scroll: false, showSwipes: false };
                    if (upward) options.insertBefore = cursor;
                    ctx.addOneMessage(ctx.chat[id], options);
                    if (upward) cursor = id;
                    index++;
                    processed++;
                }
                if (upward && scrollEl) {
                    const delta = scrollEl.scrollHeight - prevHeight;
                    if (delta) scrollEl.scrollTop += delta;
                }
                if (index >= ids.length) {
                    if (upward) chatEl.style.overflowAnchor = prevOverflowAnchor;
                    resolve();
                    return;
                }
                requestAnimationFrame(step);
            };
            requestAnimationFrame(step);
        });
    }

    async function fillEdge(direction) {
        if (filling || !rangeActive) return;
        const now = Date.now();
        if (now - lastFillTs < COOLDOWN_MS) return;

        const ctx = getCtx();
        const chat = Array.isArray(ctx?.chat) ? ctx.chat : null;
        const range = getDisplayedRange();
        if (!chat || !range || typeof ctx.addOneMessage !== 'function') return;

        const maxId = chat.length - 1;
        let ids = [];
        let insertBeforeFirst = null;

        if (direction === 'up' && range.first > 0) {
            const end = range.first - 1;
            const start = Math.max(0, end - BATCH_SIZE + 1);
            for (let i = end; i >= start; i--) ids.push(i); // 降序：紧贴现有首楼向上插
            insertBeforeFirst = range.first;
        } else if (direction === 'down' && range.last < maxId) {
            const start = range.last + 1;
            const end = Math.min(maxId, start + BATCH_SIZE - 1);
            for (let i = start; i <= end; i++) ids.push(i); // 升序：直接追加到尾部
        } else {
            return;
        }

        filling = true;
        lastFillTs = Date.now();
        try {
            const prevAutoScroll = ctx.powerUserSettings?.auto_scroll_chat_to_bottom;
            if (ctx.powerUserSettings) ctx.powerUserSettings.auto_scroll_chat_to_bottom = false;
            await insertInRafChunks(ctx, ids, insertBeforeFirst);
            // 向上补齐的 scrollTop 补偿会尾随派发 scroll 事件（可能在 filling
            // 解锁后才到达），重置基线避免被误判为新的滚动意图
            if (insertBeforeFirst) resetScrollTracking();
            notifyFloorsRendered(chat, ids);
            if (ctx.powerUserSettings) {
                ctx.powerUserSettings.auto_scroll_chat_to_bottom = prevAutoScroll;
            }
            // 通知其他依赖楼层加载事件的插件（如 JS-Slash-Runner）
            try {
                ctx.eventSource?.emit?.(ctx.eventTypes?.MORE_MESSAGES_LOADED);
            } catch { /* 事件接口不可用则跳过 */ }
        } finally {
            filling = false;
        }
    }

    // 用滚轮/触屏方向作为“加载意图”，贴边才触发；
    // 光标位于代码块 iframe 上时事件无法冒泡到本页，由 onScroll 按滚动位置兜底
    function onWheel(event) {
        if (!rangeActive || filling) return;
        const scrollEl = getScrollEl();
        if (!scrollEl) return;
        if (event.deltaY < 0 && scrollEl.scrollTop <= EDGE_THRESHOLD) {
            fillEdge('up');
        } else if (event.deltaY > 0
            && scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight <= EDGE_THRESHOLD) {
            fillEdge('down');
        }
    }

    function onTouchStart(event) {
        if (event.touches.length > 0) touchStartY = event.touches[0].clientY;
    }

    function onTouchMove(event) {
        if (!rangeActive || filling || touchStartY === null) return;
        const scrollEl = getScrollEl();
        if (!scrollEl || event.touches.length === 0) return;
        const dy = event.touches[0].clientY - touchStartY;
        if (Math.abs(dy) < 24) return;
        touchStartY = event.touches[0].clientY;
        if (dy > 0 && scrollEl.scrollTop <= EDGE_THRESHOLD) {
            fillEdge('up');
        } else if (dy < 0
            && scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight <= EDGE_THRESHOLD) {
            fillEdge('down');
        }
    }

    // ------------------------- scroll 位置兜底 -------------------------
    // 酒馆助手把代码块渲染成 iframe 后，光标悬停其上时的滚轮/触屏事件全部
    // 派发进 iframe 自身文档、不会冒泡到本页；但浏览器滚动链仍会滚动聊天容器
    // 并派发 scroll 事件，故按“滚动方向 + 贴边位置”兜底触发补齐。
    // 向上补齐的 scrollTop 补偿发生在 filling 锁内，尾随 scroll 事件由冷却拦下，无反馈循环。
    function isNearEdge(scrollEl, direction) {
        if (direction === 'up') return scrollEl.scrollTop <= EDGE_THRESHOLD;
        return scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight <= EDGE_THRESHOLD;
    }

    function onScroll() {
        const scrollEl = getScrollEl();
        if (!scrollEl) return;
        const top = scrollEl.scrollTop;
        const delta = lastScrollTop === null ? 0 : top - lastScrollTop;
        lastScrollTop = top; // 补齐期间的补偿滚动也在此刷新基线，避免之后方向误判
        if (!rangeActive || filling || Math.abs(delta) < 1) return;
        const direction = delta > 0 ? 'down' : 'up';
        if (!isNearEdge(scrollEl, direction)) return;
        if (Date.now() - lastFillTs < COOLDOWN_MS) {
            scheduleScrollRecheck(direction);
            return;
        }
        fillEdge(direction);
    }

    // 惯性滚动整体落在冷却窗口内、停在边缘后不再产生 scroll 事件的死角：
    // 冷却到期后按触发时的方向复查一次贴边状态
    function scheduleScrollRecheck(direction) {
        if (scrollRecheckTimer !== null) return;
        scrollRecheckTimer = setTimeout(() => {
            scrollRecheckTimer = null;
            const scrollEl = getScrollEl();
            if (scrollEl && rangeActive && !filling && isNearEdge(scrollEl, direction)) {
                fillEdge(direction);
            }
        }, COOLDOWN_MS + 30);
    }

    function resetScrollTracking() {
        lastScrollTop = null;
        if (scrollRecheckTimer !== null) {
            clearTimeout(scrollRecheckTimer);
            scrollRecheckTimer = null;
        }
    }

    let autoFillAttached = false;

    function attachAutoFill() {
        if (autoFillAttached) return;
        const scrollEl = getScrollEl();
        if (!scrollEl) return;
        scrollEl.addEventListener('wheel', onWheel, { passive: true });
        scrollEl.addEventListener('touchstart', onTouchStart, { passive: true });
        scrollEl.addEventListener('touchmove', onTouchMove, { passive: true });
        scrollEl.addEventListener('scroll', onScroll, { passive: true });
        autoFillAttached = true;
        cleanupFns.push(detachAutoFill);
    }

    function detachAutoFill() {
        if (!autoFillAttached) return;
        const scrollEl = getScrollEl();
        if (scrollEl) {
            scrollEl.removeEventListener('wheel', onWheel);
            scrollEl.removeEventListener('touchstart', onTouchStart);
            scrollEl.removeEventListener('touchmove', onTouchMove);
            scrollEl.removeEventListener('scroll', onScroll);
        }
        autoFillAttached = false;
        resetScrollTracking();
    }

    // ------------------------- 恢复完整显示 -------------------------
    async function restoreFullChat() {
        rangeActive = false;
        detachAutoFill();
        const ST = window.parent.SillyTavern;
        const ctx = getCtx();
        const reload = ST?.reloadCurrentChat || ctx?.reloadCurrentChat;
        if (typeof reload !== 'function') {
            toast('当前环境不支持恢复，请手动刷新聊天', 'error');
            return;
        }
        await reload();
        toast('已恢复完整显示');
    }

    // ------------------------- 弹窗交互 -------------------------
    async function promptAndJump() {
        const ctx = getCtx();
        const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
        if (chat.length === 0) {
            toast('当前聊天为空', 'warning');
            return;
        }
        const maxId = chat.length - 1;

        // 区间激活时先询问是否恢复
        if (rangeActive) {
            const restore = await askRestore();
            if (restore === null) return;      // 弹窗被关闭
            if (restore === true) return restoreFullChat();
        }

        const tip = `共 ${maxId + 1} 楼（0-${maxId}），输入楼层号跳转`;
        const value = await askInput(tip);
        if (value === null || String(value).trim() === '') return;
        if (!/^\d+$/.test(String(value).trim())) {
            toast('请输入纯数字楼层号', 'error');
            return;
        }
        await jumpTo(String(value).trim());
    }

    // 返回：true=恢复 / false=继续跳转 / null=关闭弹窗
    async function askRestore() {
        const ST = window.parent.SillyTavern;
        try {
            if (typeof ST?.callGenericPopup === 'function') {
                const result = await ST.callGenericPopup(
                    '当前为区间显示模式。\n「确定」恢复完整显示，「取消」继续输入楼层号跳转。',
                    ST.POPUP_TYPE?.CONFIRM,
                );
                if (result === 1) return true;
                if (result === -1) return false;
                return null;
            }
        } catch (e) {
            console.warn('[跳转楼层] 确认弹窗异常，降级 confirm', e);
        }
        const ok = window.confirm('当前为区间显示模式。\n「确定」恢复完整显示，「取消」继续跳转。');
        return ok ? true : false;
    }

    // 返回字符串，null 表示取消/关闭
    async function askInput(tip) {
        const ST = window.parent.SillyTavern;
        try {
            if (typeof ST?.callGenericPopup === 'function') {
                const result = await ST.callGenericPopup(tip, ST.POPUP_TYPE?.INPUT);
                if (typeof result === 'string') return result;
                if (result === null || result === undefined) return null;
                return String(result);
            }
        } catch (e) {
            console.warn('[跳转楼层] 输入弹窗异常，降级 prompt', e);
        }
        return window.prompt(tip);
    }

    // ------------------------- 按钮注入 -------------------------
    function buildButton() {
        const d = doc();
        const container = d.createElement('div');
        container.className = 'extension_container';

        const button = d.createElement('div');
        button.id = BUTTON_ID;
        button.className = 'list-group-item flex-container flexGap5';
        button.tabIndex = 0;
        button.setAttribute('role', 'button');
        button.title = '跳转到指定楼层（区间显示，上下滑动加载更多）';

        const icon = d.createElement('div');
        icon.className = 'fa-solid fa-location-arrow extensionsMenuExtensionButton';

        const label = d.createElement('span');
        label.textContent = '跳转楼层';

        button.append(icon, label);
        container.appendChild(button);
        return container;
    }

    function injectButton() {
        const d = doc();
        const menu = d.getElementById('extensionsMenu');
        if (!menu) return false;
        ensureStyle();

        // 幂等：脚本重载（如 CHAT_CHANGED）时移除旧按钮，剥离死监听后重建
        const old = d.getElementById(BUTTON_ID);
        if (old) old.closest('.extension_container')?.remove();

        const container = buildButton();
        const button = container.querySelector(`#${BUTTON_ID}`);
        const open = () => { void promptAndJump(); };
        button.addEventListener('click', open);
        button.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                open();
            }
        });
        menu.appendChild(container);
        return true;
    }

    // ------------------------- 启动 -------------------------
    function start() {
        let attempts = 0;
        const tryInject = () => {
            if (injectButton()) return;
            attempts += 1;
            if (attempts <= 40) setTimeout(tryInject, 500);
        };
        tryInject();

        // 聊天切换：区间状态作废，交还酒馆原生渲染
        try {
            if (typeof eventOn === 'function' && typeof tavern_events !== 'undefined') {
                const stop = eventOn(tavern_events.CHAT_CHANGED, () => {
                    rangeActive = false;
                    detachAutoFill();
                });
                cleanupFns.push(stop);
            }
        } catch (e) {
            console.warn('[跳转楼层] 事件订阅不可用', e);
        }

        window.addEventListener('pagehide', cleanup);
    }

    function cleanup() {
        for (const fn of cleanupFns) {
            try { fn(); } catch { /* 忽略清理异常 */ }
        }
        cleanupFns = [];
        rangeActive = false;
        detachAutoFill();
        doc().getElementById(BUTTON_ID)?.closest('.extension_container')?.remove();
        doc().getElementById(STYLE_ID)?.remove();
    }

    start();
})();
