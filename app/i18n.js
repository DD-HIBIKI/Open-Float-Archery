/**
 * OpenFloat 中文本地化层（运行时）
 * ---------------------------------------------------------------
 * 设计目标：不改动 app/ 里 30 个业务模块，只在渲染出来的 DOM 上做一层
 * 英文原文 → 中文 的替换。好处：
 *   1. 上游仓库更新时不会冲突（本文件 + app/i18n/dict-zh.js 是唯一新增）
 *   2. 可随时切回英文（原文缓存在 WeakMap 里）
 *   3. 动态 innerHTML 重渲染的内容也能翻（MutationObserver 兜底）
 *
 * 匹配顺序：精确匹配 → 以 ":" 结尾的前缀匹配（"Shots: 12" 这类）→ 少量正则
 * 跳过：script/style/textarea/pre/code/canvas/svg、contenteditable、
 *      以及标了 data-i18n-skip 的子树
 *
 * 对外接口：window.ofI18n = { t, setLang, getLang, has }
 */

import dict from "./i18n/dict-zh.js";

const LANG_KEY = "of-lang";
const ZH = "zh";
const EN = "en";

const HAS_ASCII_LETTER = /[A-Za-z]/;
const HAS_CJK = /[\u3400-\u9FFF\u3000-\u303F\uFF00-\uFFEF]/;

const SKIP_TAGS = new Set([
  "SCRIPT", "STYLE", "TEXTAREA", "PRE", "CODE", "NOSCRIPT", "CANVAS", "SVG",
  "TEMPLATE", "KBD", "SAMP", "VAR",
]);

const ATTRS = ["title", "placeholder", "aria-label", "alt", "aria-description", "aria-valuetext"];

/** 结构化匹配：前缀键（英文原文以 ":" 结尾，后面常跟数字） */
const PREFIX_KEYS = Object.keys(dict)
  .filter((k) => k.endsWith(":") || k.endsWith("："))
  .sort((a, b) => b.length - a.length);

/**
 * 兜底正则（在精确/前缀之后执行）。second 元素可以是替换串，也可以是
 * (match) => string 的函数，方便把里面的人名/标签再查一次表。
 */
const PATTERNS = [
  // 训练/会话计数
  [/^(\d+)\s+selected$/, "$1 项已选"],
  [/^(\d+)\s+shots?$/i, "$1 箭"],
  [/^(\d+)\s+of\s+(\d+)$/i, "$1 / $2"],
  [/^(\d+)\s*\/\s*(\d+)\s+shots?$/i, "$1 / $2 箭"],
  [/^(\d+)\s*\/\s*(\d+)\s+scored\s*·\s*(\d+)\s+points$/i, "$1/$2 已计分 · $3 分"],
  [/^(\d+)\s+of\s+(\d+)\s+captures scored$/i, "$1 / $2 次采集已计分"],
  [/^(\d+)\s+plotted arrows$/i, "$1 支箭已绘制"],
  [/^\/\s*(\d+)\s+arrows?$/i, "/ $1 箭"],
  [/^(\d+)\s+yd\s*\/\s*(\d+)\s+cm face$/i, "$1 yd / $2 cm 靶面"],
  // 趋势 / 差值
  [/^([+-]?[\d.]+)\s+pts,\s*([\d.]+)\s+spread$/i, "$1 分，散布 $2"],
  [/^([+-]?[\d.]+)\s+late vs early$/i, "后期相对前期 $1"],
  [/^([+-]?[\d.]+)\s+from first$/i, "相对首箭 $1"],
  [/^(Best|Low)\s+(\d+)$/i, (m) => `${m[1].toLowerCase() === "best" ? "最佳" : "最低"} ${m[2]}`],
  // 逐箭 / 逐发
  [/^Arrow\s+(\d+),\s*score\s+(\d+)\.\s*Review result$/i, (m) => `第 ${m[1]} 支箭，得分 ${m[2]}。查看结果`],
  [/^Review\s+(.+?),\s*(\d{1,2}:\d{2}:\d{2})(?:\.\s*Float\s+(\d+),\s*arrow\s+(\d+))?$/i,
    (m) => {
      const name = lookup(m[1]) || m[1];
      const tail = m[3] ? `。Float ${m[3]}，得分 ${m[4]}` : "";
      return `复盘 ${name}，${m[2]}${tail}`;
    }],
  [/^Edit\s+(.+?),\s*(\d{4}\/\d{1,2}\/\d{1,2}.*)$/, (m) => `编辑 ${lookup(m[1]) || m[1]}，${m[2]}`],
  // 设置里的遥测/采集说明
  [/^Device\s+(\d+)\s*Hz\s*\/\s*Web\s+(\d+)\s*Hz$/i, "设备 $1 Hz / 网页 $2 Hz"],
  [/^Steady Aim\s*\|\s*New baseline\s*\|\s*Target\s+(\d+)$/i, "稳定瞄准 | 新基线 | 目标 $1"],
  // 分析面板里带数字的整句
  [/^Float scores from\s+(\d+)\s+of\s+(\d+)\s+session captures\.\s*Latest scored\s+(\d+),\s*best\s+(\d+),\s*low\s+(\d+)\.$/i,
    "$2 次采集中有 $1 次算出 Float 分：最新 $3、最佳 $4、最低 $5。"],
  [/^Target plot of\s+(\d+)\s+arrow impacts\.\s*Group center is\s+(.+?)\.$/i,
    (m) => `${m[1]} 支箭的着靶分布。箭组中心${lookup(m[2].trim()) || m[2]}`],
  [/^([\d.]+)\s+avg\s*-\s*(.+)$/i, (m) => `平均 ${m[1]} 分 — ${lookup(m[2]) || m[2]}`],
  // 主题开关（index.html 里由 JS 动态改写 textContent）
  [/^THEME:\s*(PAPER|DARK|CLASSIC)$/i,
    (m) => `主题：${({ PAPER: "纸张", DARK: "深色", CLASSIC: "经典" })[m[1].toUpperCase()] || m[1]}`],
  [/^THEME:\s*(.+)$/i, "主题：$1"],
  // 计分卡下拉里的 "3 arrows" / "2 ends"
  [/^(\d+)\s+arrows?$/i, "$1 箭"],
  [/^(\d+)\s+ends?$/i, "$1 组"],

  // ---- 原生弹窗文案（confirm / alert / prompt）----
  [/^Run zero calibration\?\s*This sets the bow level reference from the sensor's current cant and pitch\.\s*Only do this when the bow is level and still\.\s*Current reading: Cant\s*(-?[\d.]+)°,?\s*Pitch\s*(-?[\d.]+)°,?\s*Yaw\s*(-?[\d.]+)°\s*Your previous calibration will be replaced\.$/,
    (m) => `要执行零点标定吗？\n\n这会把弓身当前的水平参考设为 cant 与俯仰的零点。只在弓竖直、静止不动时做这一步。\n\n当前读数：cant ${m[1]}°、俯仰 ${m[2]}°、航向 ${m[3]}°\n\n原有标定会被覆盖。`],
  [/^Delete this saved capture from this browser\?\s*(.*?)\s*Cloud copies are unchanged\.\s*This cannot be undone\.$/,
    (m) => `要从本浏览器删除这条已存箭吗？\n\n${m[1]}\n\n云端副本不变，且此操作无法撤销。`],
  [/^Delete\s+(\d+)\s+selected captures? from this browser\?\s*Cloud copies are unchanged\.\s*This cannot be undone\.$/,
    (m) => `要从本浏览器删除选中的 ${m[1]} 条已存箭吗？\n\n云端副本不变，且此操作无法撤销。`],
  [/^Error fetching trace payload:\s*(.*)$/i, "读取轨迹数据出错：$1"],
  [/^Could not delete capture:\s*(.*)$/i, "无法删除该箭：$1"],
  [/^Could not delete captures:\s*(.*)$/i, "无法删除这些箭：$1"],
  [/^Please enter both your Supabase URL and Anon Key\.$/i, "请把 Supabase URL 和 Anon Key 都填上。"],
  [/^No shot is currently being reviewed\.$/i, "当前没有正在复盘的箭。"],
];

const textOriginals = new WeakMap(); // Text -> { orig, out }
const attrOriginals = new WeakMap(); // Element -> Map(attr -> { orig, out })

let lang = EN;
let observer = null;
let pending = new Set();
let rafId = 0;
let toggleRender = null;

/* ------------------------------------------------------------------ helpers */

const normalize = (s) => s.replace(/\s+/g, " ").trim();

/** 返回译文，未命中返回 null */
function lookup(raw) {
  if (typeof raw !== "string") return null;
  if (raw.length < 2 || raw.length > 400) return null;
  if (!HAS_ASCII_LETTER.test(raw)) return null; // 纯数字/符号直接跳过（高频路径）
  if (HAS_CJK.test(raw)) return null; // 已经是中文

  const key = normalize(raw);
  if (!key) return null;

  const exact = dict[key];
  if (typeof exact === "string") return exact;

  for (let i = 0; i < PREFIX_KEYS.length; i += 1) {
    const p = PREFIX_KEYS[i];
    if (key.length > p.length && key.startsWith(p)) {
      return dict[p] + key.slice(p.length);
    }
  }

  for (let i = 0; i < PATTERNS.length; i += 1) {
    const [re, rep] = PATTERNS[i];
    if (!re.test(key)) continue;
    if (typeof rep === "function") {
      const m = key.match(re);
      if (m) return rep(m);
      continue;
    }
    return key.replace(re, rep);
  }
  return null;
}

const leadWs = (s) => (s.match(/^\s*/) || [""])[0];
const trailWs = (s) => (s.match(/\s*$/) || [""])[0];

function applyText(node) {
  const current = node.nodeValue;
  if (current == null) return;
  const rec = textOriginals.get(node);

  if (lang === EN) {
    if (rec && current === rec.out) node.nodeValue = rec.orig;
    return;
  }

  // 已经是本层写进去的译文：无需再处理（避免 observer 自激）
  if (rec && current === rec.out) return;

  // 业务模块重写过这个节点 → 当前值就是最新的原文，不能再用过期的缓存
  const source = current;
  const out = lookup(source);
  if (out == null) {
    if (rec) textOriginals.delete(node);
    return;
  }

  const next = leadWs(source) + out + trailWs(source);
  if (current === next) return;
  if (!rec) textOriginals.set(node, { orig: source, out: next });
  else {
    rec.orig = source;
    rec.out = next;
  }
  node.nodeValue = next;
}

function applyAttributes(el) {
  let map = attrOriginals.get(el);
  for (let i = 0; i < ATTRS.length; i += 1) {
    const attr = ATTRS[i];
    if (!el.hasAttribute(attr)) continue;
    const current = el.getAttribute(attr);

    if (lang === EN) {
      const rec = map && map.get(attr);
      if (rec && current === rec.out) el.setAttribute(attr, rec.orig);
      continue;
    }

    if (!map) {
      map = new Map();
      attrOriginals.set(el, map);
    }
    const rec = map.get(attr);
    if (rec && current === rec.out) continue; // 已是译文
    const source = current; // 业务模块可能改过属性值，以当前值为原文
    const out = lookup(source);
    if (out == null || current === out) {
      if (rec) map.delete(attr);
      continue;
    }
    if (!rec) map.set(attr, { orig: source, out });
    else {
      rec.orig = source;
      rec.out = out;
    }
    el.setAttribute(attr, out);
  }
}

function walk(root) {
  if (!root) return;
  const type = root.nodeType;

  if (type === Node.TEXT_NODE) {
    applyText(root);
    return;
  }
  if (type !== Node.ELEMENT_NODE && type !== Node.DOCUMENT_NODE && type !== Node.DOCUMENT_FRAGMENT_NODE) {
    return;
  }
  if (type === Node.ELEMENT_NODE) {
    if (SKIP_TAGS.has(root.tagName)) return;
    if (root.hasAttribute("data-i18n-skip")) return;
    if (root.isContentEditable) return;
    applyAttributes(root);
  }
  const children = root.childNodes;
  for (let i = 0; i < children.length; i += 1) walk(children[i]);
}

/* ---------------------------------------------------------------- observer */

function flush() {
  rafId = 0;
  const queue = pending;
  pending = new Set();
  queue.forEach((node) => {
    if (!node.isConnected) return;
    if (node.nodeType === Node.TEXT_NODE) applyText(node);
    else walk(node);
  });
}

function schedule(node) {
  pending.add(node);
  if (!rafId) rafId = requestAnimationFrame(flush);
}

function startObserver() {
  if (observer) observer.disconnect();
  observer = new MutationObserver((records) => {
    for (let i = 0; i < records.length; i += 1) {
      const record = records[i];
      if (record.type === "characterData") {
        schedule(record.target);
      } else if (record.type === "childList") {
        for (let j = 0; j < record.addedNodes.length; j += 1) schedule(record.addedNodes[j]);
      } else if (record.type === "attributes") {
        schedule(record.target);
      }
    }
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ATTRS,
  });
}

/* -------------------------------------------------------------------- 切换 */

function applyLang(next) {
  lang = next === ZH ? ZH : EN;
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch (_) {
    /* private mode */
  }
  document.documentElement.lang = lang === ZH ? "zh-CN" : "en";
  walk(document.documentElement);
  if (toggleRender) toggleRender();
  window.dispatchEvent(new CustomEvent("of-lang-changed", { detail: { lang } }));
}

function setLang(next) {
  applyLang(next);
  // 业务模块可能之后又写回英文，交给 observer；这里再补一次整树扫描更稳。
  requestAnimationFrame(() => walk(document.documentElement));
}

function getLang() {
  return lang;
}

/* ------------------------------------------------------------- 语言切换按钮 */

function ensureToggle() {
  const group = document.querySelector(".header-status-group");
  if (!group) return;

  let btn = document.getElementById("langToggle");
  if (!btn) {
    btn = document.createElement("button");
    btn.id = "langToggle";
    btn.type = "button";
    btn.className = "status clickable";
    btn.setAttribute("data-i18n-skip", "");
    group.insertBefore(btn, group.firstChild);
    btn.addEventListener("click", () => setLang(lang === ZH ? EN : ZH));
  }

  toggleRender = () => {
    // 按钮上显示"可以切换过去"的语言
    btn.textContent = lang === ZH ? "EN" : "中文";
    const label = lang === ZH ? "Switch to English" : "切换到中文";
    btn.title = label;
    btn.setAttribute("aria-label", label);
  };
  toggleRender();
}

/* ---------------------------------------------------------------- 初始化 */

function initialLang() {
  let stored = null;
  try {
    stored = localStorage.getItem(LANG_KEY);
  } catch (_) {
    /* private mode */
  }
  if (stored === ZH || stored === EN) return stored;
  const nav = (navigator.language || "").toLowerCase();
  return nav.startsWith("zh") ? ZH : EN;
}

function init() {
  ensureToggle();
  applyLang(initialLang());
  startObserver();
  // 业务模块首帧渲染后再扫一遍，保证首屏就是中文
  requestAnimationFrame(() => walk(document.documentElement));
  window.addEventListener("load", () => walk(document.documentElement), { once: true });
}

window.ofI18n = {
  t: (s) => lookup(s) || s,
  has: (s) => typeof s === "string" && dict[normalize(s)] !== undefined,
  setLang,
  getLang,
  dict,
};

/* 原生 confirm/alert/prompt 不在 DOM 里，单独包一层，让它们走同一张字典 */
(function translateNativeDialogs() {
  if (window.__ofNativeDialogsPatched) return;
  window.__ofNativeDialogsPatched = true;
  ["confirm", "alert", "prompt"].forEach((name) => {
    const original = window[name];
    if (typeof original !== "function") return;
    window[name] = function (message, ...rest) {
      if (lang === ZH && typeof message === "string") {
        const translated = lookup(message);
        if (translated) message = translated;
      }
      return original.call(window, message, ...rest);
    };
  });
})();

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
