import { ESC, s } from "./ansi.js";
let menuMod = null;
export async function loadMenuModule() {
    if (!menuMod) {
        try {
            menuMod = await import("@phren/cli/shell/render-api");
        }
        catch {
            menuMod = null;
        }
    }
    return menuMod;
}
export async function renderMenu(ctx) {
    const mod = await loadMenuModule();
    if (!mod || !ctx.phrenCtx)
        return;
    const result = await mod.renderMenuFrame(ctx.phrenCtx.phrenPath, ctx.phrenCtx.profile, ctx.menuState);
    ctx.onStateChange(ctx.menuState, result.listCount, ctx.menuFilterActive, ctx.menuFilterBuf);
    // Full-screen write: single write to avoid flicker
    ctx.w.write(`${ESC}?25l${ESC}H${ESC}2J${result.output}${ESC}?25h`);
}
export function enterMenuMode(ctx) {
    if (!ctx.phrenCtx) {
        ctx.w.write(s.yellow("  phren not configured — menu unavailable\n"));
        return;
    }
    ctx.menuState.project = ctx.phrenCtx.project ?? ctx.menuState.project;
    ctx.w.write("\x1b[?1049h"); // enter alternate screen
    renderMenu(ctx);
}
export function exitMenuMode(ctx) {
    ctx.onStateChange(ctx.menuState, ctx.menuListCount, false, "");
    ctx.w.write("\x1b[?1049l"); // leave alternate screen (restores chat)
    ctx.onExit();
}
export async function handleMenuKeypress(key, ctx) {
    // Filter input mode: capture text for / search
    if (ctx.menuFilterActive) {
        if (key.name === "escape") {
            ctx.menuState = { ...ctx.menuState, filter: undefined, cursor: 0, scroll: 0 };
            ctx.onStateChange(ctx.menuState, ctx.menuListCount, false, "");
            renderMenu(ctx);
            return;
        }
        if (key.name === "return") {
            const filter = ctx.menuFilterBuf || undefined;
            ctx.menuState = { ...ctx.menuState, filter, cursor: 0, scroll: 0 };
            ctx.onStateChange(ctx.menuState, ctx.menuListCount, false, "");
            renderMenu(ctx);
            return;
        }
        if (key.name === "backspace") {
            const buf = ctx.menuFilterBuf.slice(0, -1);
            ctx.menuState = { ...ctx.menuState, filter: buf || undefined, cursor: 0 };
            ctx.onStateChange(ctx.menuState, ctx.menuListCount, ctx.menuFilterActive, buf);
            renderMenu(ctx);
            return;
        }
        if (key.sequence && !key.ctrl && !key.meta) {
            const buf = ctx.menuFilterBuf + key.sequence;
            ctx.menuState = { ...ctx.menuState, filter: buf, cursor: 0 };
            ctx.onStateChange(ctx.menuState, ctx.menuListCount, ctx.menuFilterActive, buf);
            renderMenu(ctx);
        }
        return;
    }
    // "/" starts filter input
    if (key.sequence === "/") {
        ctx.onStateChange(ctx.menuState, ctx.menuListCount, true, "");
        return;
    }
    const mod = await loadMenuModule();
    if (!mod) {
        exitMenuMode(ctx);
        return;
    }
    const newState = mod.handleMenuKey(ctx.menuState, key.name ?? "", ctx.menuListCount, ctx.phrenCtx?.phrenPath, ctx.phrenCtx?.profile);
    if (newState === null) {
        exitMenuMode(ctx);
    }
    else {
        ctx.menuState = newState;
        renderMenu(ctx);
    }
}
