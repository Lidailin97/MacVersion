import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromeAppPath } from "./chrome_app_path.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const HARD_STOP_PATTERN =
  /今日主动沟通数已达上限|沟通权益已用完|账号异常|风险提示|操作频繁|开聊太频繁|验证码|滑块|登录失效|封禁|访问受限|异常访问/;

function runtimeDir() {
  const preferred = process.env.BOSS_RUN_DIR || path.join(os.homedir(), ".boss-feishu-greeter-260505");
  try {
    fs.mkdirSync(preferred, { recursive: true });
    return preferred;
  } catch {
    const fallback = path.join(__dirname, "..", ".run");
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

function runJxa(pageJavascript) {
  const dir = runtimeDir();
  const filePath = path.join(dir, `jxa-${Date.now()}-${Math.random().toString(16).slice(2)}.jxa`);
  const appPath = chromeAppPath();
  const source = `
function run() {
  const chrome = Application(${JSON.stringify(appPath)});
  if (!chrome.running()) return JSON.stringify({ ok: false, code: 'CHROME_NOT_RUNNING' });
  const tabs = [];
  const windows = chrome.windows();
  for (let wi = 0; wi < windows.length; wi += 1) {
    const winTabs = windows[wi].tabs();
    for (let ti = 0; ti < winTabs.length; ti += 1) {
      const tab = winTabs[ti];
      const url = String(tab.url() || '');
      if (url.includes('zhipin.com')) tabs.push({ windowIndex: wi + 1, tabIndex: ti + 1, title: String(tab.title() || ''), url });
    }
  }
  if (tabs.length === 0) return JSON.stringify({ ok: false, code: 'NO_BOSS_TAB' });
  if (tabs.length > 1) return JSON.stringify({ ok: false, code: 'MULTIPLE_BOSS_TABS', tabs });
  const targetMeta = tabs[0];
  const target = windows[targetMeta.windowIndex - 1].tabs()[targetMeta.tabIndex - 1];
  let result = '';
  try {
    result = target.execute({ javascript: ${JSON.stringify(pageJavascript)} });
  } catch (error) {
    return JSON.stringify({ ok: false, code: 'APPLE_EVENTS_JS_FAILED', error: String(error.message || error), tab: targetMeta });
  }
  return JSON.stringify({ ok: true, tab: targetMeta, result: String(result || '') });
}`;
  fs.writeFileSync(filePath, source);
  try {
    const output = execFileSync("osascript", ["-l", "JavaScript", filePath], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 10,
    }).trim();
    const wrapper = JSON.parse(output || "{}");
    if (!wrapper.ok) {
      const error = new Error(wrapper.code || "JXA_FAILED");
      error.details = wrapper;
      throw error;
    }
    return JSON.parse(wrapper.result || "{}");
  } finally {
    fs.rmSync(filePath, { force: true });
  }
}

const HELPERS = String.raw`
(() => {
  const normalize = (text) => String(text || '').replace(/\s+/g, ' ').trim();
  const compact = (text) => normalize(text).replace(/\s+/g, '').toLowerCase();
  const visible = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };
  const getDoc = () => {
    const frames = Array.from(document.querySelectorAll('iframe'));
    for (const frame of frames) {
      try {
        const doc = frame.contentDocument;
        if (doc && (frame.name === 'recommendFrame' || frame.src.includes('/web/frame/recommend/') || doc.querySelector('.candidate-card-wrap, ul.recommend-card-list > li'))) return doc;
      } catch {}
    }
    return document;
  };
  const firstText = (element, selectors) => {
    for (const selector of selectors) {
      const value = element.querySelector(selector)?.textContent?.trim();
      if (value) return value;
    }
    return '';
  };
  const textOfAll = (doc) => [document.body?.innerText || '', doc.body?.innerText || ''].join('\n');
  const clickByText = (doc, texts) => {
    const wanted = new Set(texts.map((item) => compact(item)));
    const nodes = Array.from(doc.querySelectorAll('button, a, span, div, li, label')).filter(visible);
    const found = nodes.find((node) => wanted.has(compact(node.textContent || '')));
    if (!found) return false;
    found.click();
    return true;
  };
  const getCards = (doc) => {
    const stable = Array.from(doc.querySelectorAll('ul.recommend-card-list > li')).filter((el) => el.querySelector('.btn.btn-greet, .btn.btn-continue'));
    const fallback = Array.from(doc.querySelectorAll('.candidate-card-wrap')).filter((el) => el.querySelector('.btn.btn-greet, .btn.btn-continue'));
    return stable.length ? stable : fallback;
  };
  const parseYears = (text) => {
    const source = String(text || '');
    const yearMatch = source.match(/(\d+(?:\.\d+)?)\s*年/);
    if (yearMatch) return Number(yearMatch[1]);
    if (/应届|在校/.test(source)) return 0;
    return null;
  };
  const parseAge = (text) => {
    const match = String(text || '').match(/(\d{2})\s*岁/);
    return match ? Number(match[1]) : null;
  };
  const readCard = (card, index) => {
    const name = firstText(card, ['.name-wrap .name', '.name']) || card.querySelector('.avatar')?.getAttribute('alt') || '';
    const title = firstText(card, ['.expect-wrap .content', '.expect-wrap .join-text-wrap', '.row.expect-wrap .join-text-wrap', '.expect-wrap']);
    const baseInfo = firstText(card, ['.row.base-info .join-text-wrap', '.base-info', '.row']);
    const summary = firstText(card, ['.geek-desc .content', '.geek-desc']);
    const experience = firstText(card, ['.experience-wrap .content', '.experience-wrap .join-text-wrap', '.row.experience-wrap .join-text-wrap', '.experience-wrap']);
    const tags = Array.from(card.querySelectorAll('.tags-wrap .tag-item, .operate .labels .label, .label-wrap .label')).map((item) => normalize(item.textContent)).filter(Boolean).join(' ');
    const timelineSegments = Array.from(card.querySelectorAll('.timeline-item, .timeline-wrap li')).map((item) => normalize(item.textContent)).filter(Boolean);
    const experienceSegments = [experience, ...timelineSegments].filter(Boolean);
    const timeline = timelineSegments.join(' ');
    const resume = [summary, tags, experience, timeline].filter(Boolean).join(' ');
    const button = Array.from(card.querySelectorAll('.btn.btn-greet, .btn.btn-continue')).find((item) => ['打招呼', '继续沟通'].includes(normalize(item.textContent)));
    const buttonText = normalize(button?.textContent || '');
    const fullText = [name, title, baseInfo, resume, buttonText].join(' ');
    const rect = card.getBoundingClientRect();
    const schoolText = timeline;
    const fingerprint = compact([name, title, baseInfo, schoolText].join('|'));
    return {
      index,
      fingerprint,
      name,
      title,
      baseInfo,
      resume,
      experienceSegments,
      buttonText,
      fullText,
      years: parseYears(baseInfo + ' ' + resume),
      age: parseAge(baseInfo + ' ' + resume),
      visible: visible(card),
      top: rect.top,
    };
  };
  const confirmGreet = (doc) => {
    const dialogs = Array.from(doc.querySelectorAll(".dialog-container, [class*='dialog'], [class*='modal'], [class*='popup'], .boss-popup, .ui-dialog")).filter(visible);
    for (const dialog of dialogs) {
      const text = dialog.textContent || '';
      if (!/打招呼|沟通|发送/.test(text)) continue;
      if (/筛选|清除|没有更多|刷新获取/.test(text)) continue;
      const button = Array.from(dialog.querySelectorAll("button, .btn, [role='button']")).find((el) => ['确认', '确定', '发送'].includes(normalize(el.textContent)));
      if (button) {
        button.click();
        return true;
      }
    }
    return false;
  };
  window.__bossGreeter260505 = { normalize, compact, visible, getDoc, textOfAll, clickByText, getCards, readCard, confirmGreet };
})();
`;

function execute(expression) {
  return runJxa(`${HELPERS}\n(() => {\n${expression}\n})()`);
}

export function inspectPage() {
  return execute(`
const doc = window.__bossGreeter260505.getDoc();
const text = window.__bossGreeter260505.textOfAll(doc);
const cards = window.__bossGreeter260505.getCards(doc);
return JSON.stringify({
  url: location.href,
  title: document.title,
  bodyTextLength: text.length,
  candidateCards: cards.length,
  hardStop: ${HARD_STOP_PATTERN}.test(text),
  hardStopText: (text.match(${HARD_STOP_PATTERN}) || [''])[0],
});
`);
}

export function assertReadyPage() {
  const info = inspectPage();
  if (!String(info.url || "").includes("zhipin.com")) throw new Error("当前不是 BOSS 页面");
  if (!String(info.url || "").includes("/web/chat/recommend")) throw new Error(`当前不是推荐牛人页: ${info.url}`);
  if (info.hardStop) throw new Error(`检测到风控/异常信号: ${info.hardStopText}`);
  return info;
}

export function readCurrentJobName() {
  const result = execute(`
const doc = window.__bossGreeter260505.getDoc();
const selectors = ['.job-name', '.position-name', '[class*="job-name"]', '[class*="position-name"]', '.selected-job'];
let jobName = '';
for (const selector of selectors) {
  const node = doc.querySelector(selector) || document.querySelector(selector);
  if (node && node.textContent.trim()) { jobName = node.textContent.trim(); break; }
}
if (!jobName) {
  const text = window.__bossGreeter260505.textOfAll(doc);
  const match = text.match(/([\\u4e00-\\u9fa5A-Za-z0-9_\\- ]{2,40})\\s*[｜|_]\\s*[\\u4e00-\\u9fa5]{2,}/);
  jobName = match ? match[1].trim() : document.title;
}
return JSON.stringify({ jobName });
`);
  return result.jobName || "";
}

export function applyVipFilters(rule) {
  const filter = rule.vipFilters || {};
  const labels = [
    ...(filter.areas || []),
    ...(filter.experience || []),
    ...(filter.education || []),
    ...(filter.school || []),
    ...(filter.keywords || []),
    filter.activity || "",
    filter.recentUnviewed || "",
  ].filter(Boolean);

  if (!labels.length) return { attempted: false, applied: [] };

  return execute(`
const doc = window.__bossGreeter260505.getDoc();
const labels = ${JSON.stringify(labels)};
const result = { attempted: true, opened: false, clicked: [], missing: [] };
result.opened = window.__bossGreeter260505.clickByText(doc, ['筛选']);
for (const label of labels) {
  const ok = window.__bossGreeter260505.clickByText(doc, [label]);
  if (ok) result.clicked.push(label); else result.missing.push(label);
}
if (result.clicked.length) {
  window.__bossGreeter260505.clickByText(doc, ['确定', '完成']);
}
if (result.opened && result.clicked.length === 0 && result.missing.length) {
  result.opened = false;
  result.reason = 'filter_panel_not_confirmed';
}
return JSON.stringify(result);
`);
}

export function switchJobByCity(city) {
  const targetCity = String(city || "").trim();
  if (!targetCity) return { attempted: false, switched: false, reason: "empty_city" };

  return execute(`
const doc = window.__bossGreeter260505.getDoc();
const targetCity = ${JSON.stringify(targetCity)};
const wrap = doc.querySelector('.job-selecter-wrap');
if (!wrap) {
  return JSON.stringify({ attempted: true, switched: false, reason: 'job_switcher_missing' });
}
const current = window.__bossGreeter260505.normalize(wrap.querySelector('.ui-dropmenu-label')?.textContent || wrap.textContent);
if (current.includes(targetCity)) {
  return JSON.stringify({ attempted: true, switched: false, alreadyCurrent: true, current });
}
wrap.querySelector('.ui-dropmenu-label')?.click();
wrap.click();
const items = Array.from(wrap.querySelectorAll('.job-item'));
const matches = items.filter((item) => {
  const text = window.__bossGreeter260505.normalize(item.textContent);
  return text.includes(targetCity) && /销售/i.test(text);
});
if (matches.length !== 1) {
  return JSON.stringify({
    attempted: true,
    switched: false,
    reason: matches.length === 0 ? 'job_city_missing' : 'job_city_not_unique',
    matchCount: matches.length,
    matches: matches.map((item) => window.__bossGreeter260505.normalize(item.textContent)).slice(0, 10),
  });
}
const item = matches[0];
item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
item.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
return JSON.stringify({ attempted: true, switched: true, clicked: window.__bossGreeter260505.normalize(item.textContent) });
`);
}

export function scanCandidates(limit = 15) {
  return execute(`
const doc = window.__bossGreeter260505.getDoc();
const text = window.__bossGreeter260505.textOfAll(doc);
const cards = window.__bossGreeter260505.getCards(doc)
  .map((card, index) => window.__bossGreeter260505.readCard(card, index))
  .filter((card) => card.visible && card.fingerprint)
  .sort((a, b) => a.top - b.top)
  .slice(0, ${Number(limit) || 15});
return JSON.stringify({
  hardStop: ${HARD_STOP_PATTERN}.test(text),
  hardStopText: (text.match(${HARD_STOP_PATTERN}) || [''])[0],
  cards,
});
`);
}

export function clickGreet(candidate) {
  return execute(`
const doc = window.__bossGreeter260505.getDoc();
const text = window.__bossGreeter260505.textOfAll(doc);
if (${HARD_STOP_PATTERN}.test(text)) {
  return JSON.stringify({ ok: false, hardStop: true, reason: (text.match(${HARD_STOP_PATTERN}) || [''])[0] });
} else {
  const cards = window.__bossGreeter260505.getCards(doc);
  const parsed = cards.map((card, index) => ({ element: card, raw: window.__bossGreeter260505.readCard(card, index) }));
  const target = parsed.find((item) => item.raw.fingerprint === ${JSON.stringify(candidate.fingerprint)});
  if (!target) {
    return JSON.stringify({ ok: false, reason: 'candidate_not_found' });
  } else if (target.raw.buttonText !== '打招呼') {
    return JSON.stringify({ ok: false, reason: 'button_not_greet', buttonText: target.raw.buttonText });
  } else {
    target.element.scrollIntoView({ block: 'center', behavior: 'instant' });
    const button = Array.from(target.element.querySelectorAll('.btn.btn-greet, .btn.btn-continue')).find((el) => window.__bossGreeter260505.normalize(el.textContent) === '打招呼');
    if (!button) {
      return JSON.stringify({ ok: false, reason: 'button_missing_after_scroll' });
    } else {
      button.click();
      setTimeout(() => window.__bossGreeter260505.confirmGreet(doc), 500);
      return JSON.stringify({ ok: true, clicked: true, name: target.raw.name });
    }
  }
}
`);
}

export function verifyGreet(candidate) {
  return execute(`
const doc = window.__bossGreeter260505.getDoc();
const text = window.__bossGreeter260505.textOfAll(doc);
const cards = window.__bossGreeter260505.getCards(doc);
const parsed = cards.map((card, index) => window.__bossGreeter260505.readCard(card, index));
const target = parsed.find((item) => item.fingerprint === ${JSON.stringify(candidate.fingerprint)} || item.name === ${JSON.stringify(candidate.name)});
return JSON.stringify({
  hardStop: ${HARD_STOP_PATTERN}.test(text),
  hardStopText: (text.match(${HARD_STOP_PATTERN}) || [''])[0],
  found: Boolean(target),
  buttonText: target?.buttonText || '',
  success: target ? target.buttonText === '继续沟通' : true,
});
`);
}

export function scrollForMore() {
  return execute(`
const doc = window.__bossGreeter260505.getDoc();
const candidates = [doc.scrollingElement, doc.documentElement, doc.body, ...Array.from(doc.querySelectorAll('*'))].filter(Boolean);
let best = doc.scrollingElement || doc.documentElement || doc.body;
let bestRange = -1;
for (const element of candidates) {
  const range = Number(element.scrollHeight || 0) - Number(element.clientHeight || 0);
  if (range <= 8) continue;
  const style = element === doc.documentElement || element === doc.body || element === doc.scrollingElement ? { overflowY: 'auto' } : getComputedStyle(element);
  if (!/(auto|scroll|overlay)/i.test(style.overflowY || '')) continue;
  if (range > bestRange) { best = element; bestRange = range; }
}
const beforeTop = Number(best.scrollTop || 0);
const step = Math.max(500, Math.floor((best.clientHeight || innerHeight) * 0.7));
best.scrollTop = Math.min(beforeTop + step, Math.max(0, Number(best.scrollHeight || 0) - Number(best.clientHeight || 0)));
return JSON.stringify({ beforeTop, afterTop: Number(best.scrollTop || 0), moved: Number(best.scrollTop || 0) !== beforeTop });
`);
}

export function refreshRecommendPool() {
  return execute(`
const doc = window.__bossGreeter260505.getDoc();
const text = window.__bossGreeter260505.textOfAll(doc);
if (${HARD_STOP_PATTERN}.test(text)) {
  return JSON.stringify({ ok: false, hardStop: true, reason: (text.match(${HARD_STOP_PATTERN}) || [''])[0] });
}
const compact = window.__bossGreeter260505.compact;
const visible = window.__bossGreeter260505.visible;
const scrollCandidates = [doc.scrollingElement, doc.documentElement, doc.body, ...Array.from(doc.querySelectorAll('*'))].filter(Boolean);
let best = doc.scrollingElement || doc.documentElement || doc.body;
let bestRange = -1;
for (const element of scrollCandidates) {
  const range = Number(element.scrollHeight || 0) - Number(element.clientHeight || 0);
  if (range <= 8) continue;
  const style = element === doc.documentElement || element === doc.body || element === doc.scrollingElement ? { overflowY: 'auto' } : getComputedStyle(element);
  if (!/(auto|scroll|overlay)/i.test(style.overflowY || '')) continue;
  if (range > bestRange) { best = element; bestRange = range; }
}
if (best) best.scrollTop = 0;
for (const element of [doc.scrollingElement, doc.documentElement, doc.body].filter(Boolean)) element.scrollTop = 0;
const nodes = Array.from(doc.querySelectorAll('li.tab-item, .tab-item, [class*="tab"], button, a, span, div'))
  .filter(visible)
  .filter((node) => {
    const text = compact(node.textContent || '');
    return text === '推荐' || /^推荐\\d+$/.test(text);
  })
  .map((node) => ({ node, rect: node.getBoundingClientRect() }))
  .filter((item) => item.rect.left > 20 && item.rect.top >= 0 && item.rect.top < 180)
  .sort((left, right) => (left.rect.top - right.rect.top) || (left.rect.left - right.rect.left));
const target = nodes[0]?.node;
if (!target) return JSON.stringify({ ok: false, reason: 'recommend_tab_not_found' });
target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
return JSON.stringify({ ok: true, clicked: true, text: window.__bossGreeter260505.normalize(target.textContent || '') });
`);
}
