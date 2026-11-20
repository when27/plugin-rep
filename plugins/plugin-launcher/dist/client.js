window.__ModuleLoader__.load({
  id: "plugin-launcher",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.__test = exports.TOOL_REGISTRY_KEY = exports.inject = exports.name = void 0;
    exports.normalizeTool = normalizeTool;
    exports.sortTools = sortTools;
    exports.createLauncherRegistry = createLauncherRegistry;
    exports.ensureLauncherRegistry = ensureLauncherRegistry;
    exports.createLauncherController = createLauncherController;
    exports.apply = apply;
    exports.LauncherButton = LauncherButton;
    exports.ToolList = ToolList;
    exports.EmptyState = EmptyState;
    exports.runTool = runTool;
    const jsx_runtime_1 = require("react/jsx-runtime");
    const react_1 = require("react");
    const react_dom_1 = require("react-dom");
    exports.name = 'plugin-launcher';
    // `slots` comes from the renderer sibling fiber; reading `ctx.slots` without
    // declaring it throws and the web-boot audit reports the plugin as failed.
    exports.inject = ['slots'];
    const SIDEBAR_LABEL = 'Plugin Tools';
    const OPEN_KEY = 'plugin-launcher.open.v1';
    exports.TOOL_REGISTRY_KEY = '__DSH_PLUGIN_LAUNCHER_V1__';
    function normalizeTool(tool) {
        if (tool === null || typeof tool !== 'object') {
            throw new TypeError('plugin-launcher: a tool must be an object');
        }
        const id = typeof tool.id === 'string' ? tool.id.trim() : '';
        if (id === '')
            throw new TypeError('plugin-launcher: tool.id must be a non-empty string');
        if (typeof tool.onOpen !== 'function') {
            throw new TypeError(`plugin-launcher: tool "${id}" needs an onOpen() function`);
        }
        const label = typeof tool.label === 'string' && tool.label.trim() !== '' ? tool.label.trim() : id;
        const order = typeof tool.order === 'number' && Number.isFinite(tool.order) ? tool.order : 0;
        return { ...tool, id, label, order };
    }
    /** Pure sort used by the snapshot so equal-order tools stay alphabetical. */
    function sortTools(tools) {
        return [...tools].sort((left, right) => {
            const order = (left.order ?? 0) - (right.order ?? 0);
            return order !== 0 ? order : left.label.localeCompare(right.label);
        });
    }
    function createLauncherRegistry(host = defaultHost()) {
        const tools = new Map();
        const listeners = new Set();
        let cached = null;
        let disposed = false;
        const emit = () => {
            for (const listener of Array.from(listeners)) {
                try {
                    listener();
                }
                catch {
                    /* a broken subscriber must not break the registry */
                }
            }
        };
        return {
            version: 1,
            register(tool) {
                if (disposed)
                    throw new Error('plugin-launcher: registry was disposed');
                const entry = normalizeTool(tool);
                // A re-registration under the same id replaces the old row.
                tools.set(entry.id, entry);
                cached = null;
                emit();
                return () => {
                    if (tools.get(entry.id) !== entry)
                        return;
                    tools.delete(entry.id);
                    cached = null;
                    emit();
                };
            },
            getSnapshot() {
                if (cached === null)
                    cached = sortTools(Array.from(tools.values()));
                return cached;
            },
            subscribe(listener) {
                listeners.add(listener);
                return () => {
                    listeners.delete(listener);
                };
            },
            get(id) {
                return tools.get(id) ?? null;
            },
            select(id) {
                const tool = tools.get(id);
                if (tool === undefined)
                    return false;
                try {
                    tool.onOpen();
                }
                catch (error) {
                    // One faulty plugin must not break the launcher for the others.
                    try {
                        host?.console?.error?.('[plugin-launcher] tool failed to open', error);
                    }
                    catch {
                        /* ignore consoles that cannot be written */
                    }
                }
                return true;
            },
        };
    }
    /**
     * Adopt the registry another bundle already created, or create it. This is the
     * load-order-independent seam: `plugin-launcher` may load before or after any
     * plugin that registers tools.
     */
    function ensureLauncherRegistry(host = defaultHost()) {
        const existing = host?.[exports.TOOL_REGISTRY_KEY];
        if (existing !== null &&
            typeof existing === 'object' &&
            existing.version === 1 &&
            typeof existing.register === 'function' &&
            typeof existing.getSnapshot === 'function' &&
            typeof existing.subscribe === 'function') {
            return existing;
        }
        const registry = createLauncherRegistry(host);
        try {
            Object.defineProperty(host, exports.TOOL_REGISTRY_KEY, {
                value: registry,
                configurable: true,
                enumerable: false,
                writable: false,
            });
        }
        catch {
            host[exports.TOOL_REGISTRY_KEY] = registry;
        }
        return registry;
    }
    function defaultHost() {
        return typeof window === 'undefined' ? {} : window;
    }
    function createLauncherController(storage = defaultStorage()) {
        let open = readOpen(storage);
        const listeners = new Set();
        const emit = () => {
            for (const listener of Array.from(listeners)) {
                try {
                    listener();
                }
                catch {
                    /* keep the other listeners alive */
                }
            }
        };
        return {
            getOpen: () => open,
            setOpen(next) {
                if (open === next)
                    return;
                open = next;
                writeOpen(storage, next);
                emit();
            },
            toggle() {
                open = !open;
                writeOpen(storage, open);
                emit();
            },
            subscribe(listener) {
                listeners.add(listener);
                return () => {
                    listeners.delete(listener);
                };
            },
        };
    }
    function defaultStorage() {
        try {
            return typeof localStorage === 'undefined' ? null : localStorage;
        }
        catch {
            return null;
        }
    }
    function readOpen(storage) {
        try {
            return storage?.getItem(OPEN_KEY) === '1';
        }
        catch {
            return false;
        }
    }
    function writeOpen(storage, open) {
        try {
            storage?.setItem(OPEN_KEY, open ? '1' : '0');
        }
        catch {
            /* private mode / quota: the in-memory value still works */
        }
    }
    // ---------------------------------------------------------------------------
    // Hooks
    // ---------------------------------------------------------------------------
    function useLauncherOpen(controller) {
        return (0, react_1.useSyncExternalStore)(controller.subscribe, controller.getOpen, controller.getOpen);
    }
    function useRegistryTools(registry) {
        return (0, react_1.useSyncExternalStore)(registry.subscribe, registry.getSnapshot, registry.getSnapshot);
    }
    // ---------------------------------------------------------------------------
    // Slot occupants
    // ---------------------------------------------------------------------------
    function apply(ctx) {
        // Adopt a registry created by an earlier-loaded registrant, or create it.
        const registry = ensureLauncherRegistry();
        const controller = createLauncherController();
        // The one global-sidebar cell every plugin tool sits behind.
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
            name: 'sidebar.footer.action',
            id: 'plugin-launcher',
            order: 0,
            label: () => SIDEBAR_LABEL,
        }, (props) => (0, react_1.createElement)(LauncherButton, { wide: props.wide === true, controller })));
        // Centered tools-selection modal in the frame-wide floating layer.
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'plugin-launcher-modal', order: 120 }, () => (0, react_1.createElement)(LauncherOverlay, { registry, controller })));
    }
    function LauncherGlyph({ size = 16 }) {
        return ((0, jsx_runtime_1.jsxs)("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", style: { flex: '0 0 auto', display: 'block' }, children: [(0, jsx_runtime_1.jsx)("rect", { x: "3.5", y: "3.5", width: "7", height: "7", rx: "1.6" }), (0, jsx_runtime_1.jsx)("rect", { x: "13.5", y: "3.5", width: "7", height: "7", rx: "1.6" }), (0, jsx_runtime_1.jsx)("rect", { x: "3.5", y: "13.5", width: "7", height: "7", rx: "1.6" }), (0, jsx_runtime_1.jsx)("rect", { x: "13.5", y: "13.5", width: "7", height: "7", rx: "1.6" })] }));
    }
    /**
     * One sidebar cell, matching the geometry and tokens of the other sidebar
     * actions: a 32px row that collapses to a 32px square in the rail, with an
     * accent tint while its popup is open.
     */
    function LauncherButton({ wide, controller, }) {
        const open = useLauncherOpen(controller);
        const iconSize = wide ? 15 : 17;
        const idleColor = 'var(--dsw-alias-label-secondary, inherit)';
        const activeBackground = 'rgba(126, 224, 189, 0.14)';
        const activeColor = '#7ee0bd';
        const style = {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: wide ? 'flex-start' : 'center',
            gap: 8,
            width: wide ? '100%' : 32,
            height: 32,
            flex: '0 1 auto',
            minWidth: 0,
            padding: wide ? '0 9px' : 0,
            border: 0,
            borderRadius: 8,
            background: open ? activeBackground : 'transparent',
            color: open ? activeColor : idleColor,
            font: 'inherit',
            fontSize: 12,
            lineHeight: '18px',
            cursor: 'pointer',
            textAlign: 'left',
        };
        return ((0, jsx_runtime_1.jsxs)("button", { type: "button", style: style, title: open ? `Close ${SIDEBAR_LABEL}` : `Open ${SIDEBAR_LABEL}`, "aria-label": open ? `Close ${SIDEBAR_LABEL}` : `Open ${SIDEBAR_LABEL}`, "aria-haspopup": "dialog", "aria-pressed": open, onClick: () => controller.toggle(), onMouseEnter: (event) => {
                event.currentTarget.style.background = open
                    ? activeBackground
                    : 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.14))';
                event.currentTarget.style.color = open
                    ? activeColor
                    : 'var(--dsw-alias-label-primary, inherit)';
            }, onMouseLeave: (event) => {
                event.currentTarget.style.background = open ? activeBackground : 'transparent';
                event.currentTarget.style.color = open ? activeColor : idleColor;
            }, children: [(0, jsx_runtime_1.jsx)(LauncherGlyph, { size: iconSize }), wide ? ((0, jsx_runtime_1.jsx)("span", { style: {
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        color: 'inherit',
                    }, children: SIDEBAR_LABEL })) : null] }));
    }
    function LauncherOverlay({ registry, controller, }) {
        const open = useLauncherOpen(controller);
        if (!open)
            return null;
        return (0, react_1.createElement)(LauncherDialog, { registry, controller });
    }
    // ---------------------------------------------------------------------------
    // Modal
    // ---------------------------------------------------------------------------
    function LauncherDialog({ registry, controller, }) {
        const tools = useRegistryTools(registry);
        const titleId = (0, react_1.useId)();
        const dialogRef = (0, react_1.useRef)(null);
        const pressedInsideRef = (0, react_1.useRef)(false);
        // Native modal: the browser provides the top layer, inert page, focus
        // containment and Escape/close requests. No manual focus trap or aria-modal.
        (0, react_1.useLayoutEffect)(() => {
            const dialog = dialogRef.current;
            if (dialog === null)
                return undefined;
            if (typeof dialog.showModal === 'function') {
                if (!dialog.open)
                    dialog.showModal();
            }
            else if (!dialog.open) {
                dialog.setAttribute('open', '');
            }
            return () => {
                if (dialog.open)
                    dialog.close();
            };
        }, []);
        const requestClose = () => controller.setOpen(false);
        return (0, react_dom_1.createPortal)((0, jsx_runtime_1.jsxs)("dialog", { ref: dialogRef, className: "dpl-dialog", "aria-labelledby": titleId, onCancel: (event) => {
                // Escape and platform close requests both arrive here; route them
                // through the shared controller so the sidebar state stays in sync.
                event.preventDefault();
                requestClose();
            }, onPointerDown: (event) => {
                // Light-dismiss guard: a drag that started inside the panel and ended
                // on the backdrop must not count as a backdrop click.
                pressedInsideRef.current = event.target !== dialogRef.current;
            }, onClick: (event) => {
                if (event.target !== dialogRef.current)
                    return;
                if (pressedInsideRef.current) {
                    pressedInsideRef.current = false;
                    return;
                }
                requestClose();
            }, children: [(0, jsx_runtime_1.jsx)("style", { children: CSS }), (0, jsx_runtime_1.jsxs)("header", { className: "dpl-head", children: [(0, jsx_runtime_1.jsx)("span", { className: "dpl-mark", "aria-hidden": "true", children: (0, jsx_runtime_1.jsx)(LauncherGlyph, { size: 19 }) }), (0, jsx_runtime_1.jsxs)("div", { className: "dpl-heading", children: [(0, jsx_runtime_1.jsx)("h2", { id: titleId, className: "dpl-title", children: "Plugin Tools" }), (0, jsx_runtime_1.jsx)("p", { className: "dpl-sub", children: "Open any installed plugin surface from one place." })] }), (0, jsx_runtime_1.jsx)("button", { type: "button", className: "dpl-x", "aria-label": "Close plugin tools", autoFocus: true, onClick: requestClose, children: "\u00D7" })] }), (0, jsx_runtime_1.jsx)("div", { className: "dpl-body", children: tools.length === 0 ? (0, jsx_runtime_1.jsx)(EmptyState, {}) : (0, jsx_runtime_1.jsx)(ToolList, { tools: tools, onSelect: (tool) => runTool(registry, controller, tool.id) }) }), (0, jsx_runtime_1.jsxs)("footer", { className: "dpl-foot", children: [(0, jsx_runtime_1.jsxs)("span", { children: [tools.length, " ", tools.length === 1 ? 'tool' : 'tools'] }), (0, jsx_runtime_1.jsxs)("span", { className: "dpl-hint", children: [(0, jsx_runtime_1.jsx)("kbd", { children: "Esc" }), " to close"] })] })] }), document.body);
    }
    function ToolList({ tools, onSelect, }) {
        return ((0, jsx_runtime_1.jsx)("ul", { className: "dpl-list", "aria-label": "Registered plugin tools", children: tools.map((tool) => ((0, jsx_runtime_1.jsx)("li", { children: (0, jsx_runtime_1.jsxs)("button", { type: "button", className: "dpl-row", "data-tool-id": tool.id, onClick: () => onSelect(tool), children: [(0, jsx_runtime_1.jsx)(ToolGlyph, { tool: tool }), (0, jsx_runtime_1.jsxs)("span", { className: "dpl-copy", children: [(0, jsx_runtime_1.jsxs)("span", { className: "dpl-row-head", children: [(0, jsx_runtime_1.jsx)("span", { className: "dpl-label", children: tool.label }), tool.badge ? (0, jsx_runtime_1.jsx)("span", { className: "dpl-badge", children: tool.badge }) : null] }), tool.description ? ((0, jsx_runtime_1.jsx)("span", { className: "dpl-desc", children: tool.description })) : null] }), (0, jsx_runtime_1.jsx)("span", { className: "dpl-chevron", "aria-hidden": "true", children: "\u203A" })] }) }, tool.id))) }));
    }
    function EmptyState() {
        return ((0, jsx_runtime_1.jsxs)("div", { className: "dpl-empty", role: "status", children: [(0, jsx_runtime_1.jsx)("span", { className: "dpl-empty-icon", "aria-hidden": "true", children: (0, jsx_runtime_1.jsx)(LauncherGlyph, { size: 25 }) }), (0, jsx_runtime_1.jsx)("p", { className: "dpl-empty-title", children: "No plugin tools registered yet" }), (0, jsx_runtime_1.jsx)("p", { className: "dpl-empty-body", children: "Plugins add a row here when they load. Enable or install a plugin that exposes a tool, then reopen this menu." })] }));
    }
    function ToolGlyph({ tool }) {
        if (typeof tool.icon === 'string' && tool.icon.trim() !== '') {
            return ((0, jsx_runtime_1.jsx)("span", { className: "dpl-glyph dpl-glyph-text", "aria-hidden": "true", children: tool.icon }));
        }
        return ((0, jsx_runtime_1.jsx)("span", { className: "dpl-glyph", "aria-hidden": "true", children: tool.icon ?? (0, jsx_runtime_1.jsx)(LauncherGlyph, { size: 19 }) }));
    }
    /**
     * Close the modal first, then hand control to the selected plugin. Unknown ids
     * are ignored so a stale row cannot close the menu.
     */
    function runTool(registry, controller, id) {
        const launched = registry.select(id);
        if (launched)
            controller.setOpen(false);
        return launched;
    }
    // ---------------------------------------------------------------------------
    // Styles. Scoped to the dialog so the host theme tokens keep driving the
    // sidebar button itself; the panel uses the plugins' shared dark palette.
    // ---------------------------------------------------------------------------
    const CSS = String.raw `
    .dpl-dialog {
      --dpl-bg: #0b1016;
      --dpl-surface: #111823;
      --dpl-surface-2: #161f2c;
      --dpl-line: rgba(160, 184, 214, 0.14);
      --dpl-line-strong: rgba(160, 184, 214, 0.24);
      --dpl-text: #edf2fa;
      --dpl-muted: #8b99ad;
      --dpl-faint: #64748b;
      --dpl-accent: #7ee0bd;
      position: fixed;
      inset: 0;
      margin: auto;
      width: min(560px, calc(100vw - 32px));
      max-height: min(640px, calc(100dvh - 64px));
      display: flex;
      flex-direction: column;
      overflow: hidden;
      padding: 0;
      border: 0;
      border-radius: 18px;
      background: var(--dpl-bg);
      color: var(--dpl-text);
      font-family: Inter, "Segoe UI Variable", "Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 13px;
      line-height: 1.45;
      box-shadow: 0 32px 90px rgba(0, 0, 0, 0.66), 0 8px 24px rgba(0, 0, 0, 0.45), inset 0 0 0 1px rgba(160, 184, 214, 0.08);
      -webkit-font-smoothing: antialiased;
      overscroll-behavior: contain;
      animation: dpl-dialog-in 150ms cubic-bezier(0.22, 1, 0.36, 1);
    }
    .dpl-dialog::backdrop {
      background: rgba(3, 6, 10, 0.64);
      backdrop-filter: blur(3px);
      -webkit-backdrop-filter: blur(3px);
      overscroll-behavior: contain;
      animation: dpl-backdrop-in 150ms ease-out;
    }
    .dpl-dialog:focus { outline: none; }
    .dpl-dialog *, .dpl-dialog *::before, .dpl-dialog *::after { box-sizing: border-box; }
    .dpl-dialog button { font: inherit; }
    .dpl-dialog :focus-visible { outline: 2px solid rgba(126, 224, 189, 0.6); outline-offset: 2px; }

    .dpl-head {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 16px 14px 14px 18px;
      border-bottom: 1px solid var(--dpl-line);
      background: linear-gradient(180deg, rgba(126, 224, 189, 0.05), transparent);
    }
    .dpl-mark {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 38px;
      height: 38px;
      border-radius: 11px;
      border: 1px solid rgba(126, 224, 189, 0.22);
      background: rgba(126, 224, 189, 0.09);
      color: var(--dpl-accent);
    }
    .dpl-heading { flex: 1 1 auto; min-width: 0; }
    .dpl-title {
      margin: 0;
      font-size: 15px;
      font-weight: 650;
      letter-spacing: 0.01em;
      color: var(--dpl-text);
    }
    .dpl-sub {
      margin: 2px 0 0;
      font-size: 12px;
      color: var(--dpl-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .dpl-x {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 30px;
      height: 30px;
      padding: 0 0 2px;
      border: 1px solid transparent;
      border-radius: 9px;
      background: transparent;
      color: var(--dpl-muted);
      font-size: 20px;
      line-height: 1;
      cursor: pointer;
    }
    .dpl-x:hover { background: var(--dpl-surface-2); color: var(--dpl-text); border-color: var(--dpl-line); }

    .dpl-body {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      padding: 10px;
      scrollbar-width: thin;
      scrollbar-color: rgba(160, 184, 214, 0.28) transparent;
    }
    .dpl-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
    .dpl-row {
      display: flex;
      align-items: center;
      gap: 12px;
      width: 100%;
      padding: 10px 10px 10px 11px;
      border: 1px solid transparent;
      border-radius: 12px;
      background: transparent;
      color: var(--dpl-text);
      text-align: left;
      cursor: pointer;
      transition: background 120ms ease, border-color 120ms ease;
    }
    .dpl-row:hover { background: var(--dpl-surface); border-color: var(--dpl-line); }
    .dpl-row:active { background: var(--dpl-surface-2); }
    .dpl-glyph {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
      border-radius: 10px;
      border: 1px solid var(--dpl-line);
      background: var(--dpl-surface-2);
      color: var(--dpl-accent);
    }
    .dpl-glyph-text { font-size: 17px; color: var(--dpl-text); }
    .dpl-copy { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .dpl-row-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .dpl-label {
      font-size: 13px;
      font-weight: 600;
      color: var(--dpl-text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .dpl-desc {
      font-size: 12px;
      color: var(--dpl-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .dpl-badge {
      flex: 0 0 auto;
      padding: 1px 6px;
      border-radius: 999px;
      border: 1px solid rgba(126, 224, 189, 0.24);
      background: rgba(126, 224, 189, 0.1);
      color: var(--dpl-accent);
      font-size: 9.5px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .dpl-chevron { flex: 0 0 auto; color: var(--dpl-faint); font-size: 19px; line-height: 1; }

    .dpl-empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 4px;
      min-height: 210px;
      padding: 28px 26px;
      text-align: center;
    }
    .dpl-empty-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 52px;
      height: 52px;
      margin-bottom: 8px;
      border-radius: 15px;
      border: 1px dashed var(--dpl-line-strong);
      background: var(--dpl-surface);
      color: var(--dpl-faint);
    }
    .dpl-empty-title { margin: 0; font-size: 13.5px; font-weight: 600; color: var(--dpl-text); }
    .dpl-empty-body { margin: 0; max-width: 330px; font-size: 12px; color: var(--dpl-muted); }

    .dpl-foot {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 16px;
      border-top: 1px solid var(--dpl-line);
      color: var(--dpl-faint);
      font-size: 11px;
    }
    .dpl-hint { display: inline-flex; align-items: center; gap: 6px; }
    .dpl-hint kbd {
      padding: 1px 5px;
      border: 1px solid var(--dpl-line-strong);
      border-bottom-width: 2px;
      border-radius: 5px;
      background: var(--dpl-surface);
      color: var(--dpl-muted);
      font-family: inherit;
      font-size: 10px;
    }

    @keyframes dpl-dialog-in {
      from { opacity: 0; transform: translateY(8px) scale(0.985); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    @keyframes dpl-backdrop-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @media (prefers-reduced-motion: reduce) {
      .dpl-dialog, .dpl-dialog::backdrop { animation: none; }
    }
    `;
    // ---------------------------------------------------------------------------
    // Test seams (not used by the runtime).
    // ---------------------------------------------------------------------------
    exports.__test = {
        TOOL_REGISTRY_KEY: exports.TOOL_REGISTRY_KEY,
        OPEN_KEY,
        SIDEBAR_LABEL,
        createLauncherRegistry,
        ensureLauncherRegistry,
        createLauncherController,
        normalizeTool,
        sortTools,
        runTool,
        ToolList,
        EmptyState,
        LauncherGlyph,
    };
    return module.exports;
  },
});
