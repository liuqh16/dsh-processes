window.__ModuleLoader__.load({
	id: 'dsh-processes-web',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.tsx
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);

// src/client/ProcessDock.tsx
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
var STATUS_KEY = {
  running: "process.status.running",
  terminating: "process.status.terminating",
  finished: "process.status.finished",
  failed: "process.status.failed",
  killed: "process.status.killed",
  terminate_timeout: "process.status.terminate_timeout"
};
var styles = {
  strip: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    height: 32,
    padding: "0 12px",
    margin: "0 auto",
    maxWidth: 720,
    boxSizing: "border-box",
    border: "1px solid var(--dsw-alias-border-l1)",
    background: "var(--dsw-specific-tip)",
    borderRadius: 10,
    cursor: "pointer",
    color: "var(--dsw-alias-label-secondary)",
    fontSize: 13
  },
  badge: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontWeight: 600
  },
  caret: {
    marginLeft: "auto",
    color: "var(--dsw-alias-label-tertiary)"
  },
  panel: {
    margin: "0 auto",
    maxWidth: 720,
    boxSizing: "border-box",
    border: "1px solid var(--dsw-alias-border-l1)",
    background: "var(--dsw-alias-bg-base)",
    borderRadius: 10,
    marginTop: 4,
    padding: 8,
    fontSize: 13,
    maxHeight: 280,
    overflowY: "auto"
  },
  row: {
    display: "flex",
    alignItems: "baseline",
    gap: 10,
    padding: "5px 8px",
    borderRadius: 6
  },
  name: {
    fontWeight: 600,
    color: "var(--dsw-alias-label-primary)",
    whiteSpace: "nowrap"
  },
  command: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: "var(--dsw-alias-label-tertiary)"
  },
  status: {
    flex: "none",
    color: "var(--dsw-alias-label-secondary)"
  },
  notify: {
    color: "var(--dsw-alias-label-caption)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    maxWidth: 260
  },
  empty: {
    padding: "8px",
    color: "var(--dsw-alias-label-caption)"
  }
};
function ProcessRow({ entry, t }) {
  const status = t(STATUS_KEY[entry.status]);
  const exit = entry.status === "finished" || entry.status === "failed" ? " " + (entry.exitCode === null ? "" : "exit " + entry.exitCode) : entry.exitSignal === null ? "" : " " + entry.exitSignal;
  const notify = entry.lastNotify === null ? t("process.noNotify") : t("process.notify", { text: entry.lastNotify });
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.row, title: entry.command, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.name, children: entry.name }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.command, children: entry.command }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: styles.status, children: [
      status,
      exit
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.notify, children: notify })
  ] });
}
function ProcessDock({ useProjection, t }) {
  const projection = useProjection("processes");
  const [open, setOpen] = (0, import_react.useState)(false);
  if (projection === void 0 || projection.processes.length === 0) return null;
  const { processes, running } = projection;
  const label = running === 0 ? t("dock.none") : t("dock.running", { count: String(running) });
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { role: "group", "aria-label": t("dock.aria"), children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
      "div",
      {
        style: styles.strip,
        role: "button",
        "aria-expanded": open,
        tabIndex: 0,
        onClick: () => setOpen(!open),
        onKeyDown: (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen(!open);
          }
        },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.badge, children: label }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.caret, children: open ? "\u25BE" : "\u25B8" })
        ]
      }
    ),
    open && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.panel, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { ...styles.row, fontWeight: 600 }, children: t("panel.title") }),
      processes.map((entry) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ProcessRow, { entry, t }, entry.id)),
      processes.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: styles.empty, children: t("process.empty") })
    ] })
  ] });
}

// src/client/locales.ts
var NS = "processes";
var zh = {
  "dock.aria": "\u540E\u53F0\u8FDB\u7A0B",
  "dock.running": "{count} \u4E2A\u8FDB\u7A0B\u8FD0\u884C\u4E2D",
  "dock.none": "\u65E0\u540E\u53F0\u8FDB\u7A0B",
  "panel.title": "\u540E\u53F0\u8FDB\u7A0B",
  "process.status.running": "\u8FD0\u884C\u4E2D",
  "process.status.terminating": "\u505C\u6B62\u4E2D",
  "process.status.finished": "\u5DF2\u7ED3\u675F",
  "process.status.failed": "\u5DF2\u5931\u8D25",
  "process.status.killed": "\u5DF2\u7EC8\u6B62",
  "process.status.terminate_timeout": "\u505C\u6B62\u8D85\u65F6",
  "process.notify": "\u6700\u8FD1\u901A\u77E5\uFF1A{text}",
  "process.noNotify": "\u65E0\u901A\u77E5",
  "process.empty": "\u5C1A\u672A\u542F\u52A8\u540E\u53F0\u8FDB\u7A0B\u3002\u7528 process \u5DE5\u5177\uFF08action: start\uFF09\u542F\u52A8\u3002",
  "panel.close": "\u6536\u8D77"
};
var en = {
  "dock.aria": "Background processes",
  "dock.running": "{count} process(es) running",
  "dock.none": "No background processes",
  "panel.title": "Background processes",
  "process.status.running": "running",
  "process.status.terminating": "stopping",
  "process.status.finished": "finished",
  "process.status.failed": "failed",
  "process.status.killed": "terminated",
  "process.status.terminate_timeout": "stop timed out",
  "process.notify": "Latest: {text}",
  "process.noNotify": "No notifications",
  "process.empty": "No background processes yet. Start one with the process tool (action: start).",
  "panel.close": "Collapse"
};

// src/client/index.tsx
var inject = ["slots", "sessions", "locale"];
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-processes-web: dictionaries");
  ctx.slots.inject(
    "conversation.input.dock",
    () => ctx.slots.register({
      name: "conversation.input.dock",
      id: "processes",
      // After the goal strip: process work reads as operational state.
      order: 30,
      locale: NS
    }, ProcessDock)
  );
}

		return module.exports;
	}
});
