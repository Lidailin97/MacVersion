import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const BASE_URL = "https://open.feishu.cn/open-apis";

let tokenCache = { token: "", expireAt: 0 };

function loadLocalConfig() {
  for (const name of ["config.private.json", "config.json"]) {
    const filePath = path.join(__dirname, "..", name);
    if (fs.existsSync(filePath)) return require(filePath);
  }
  return {};
}

function pick(localValue, envName) {
  return process.env[envName] || localValue || "";
}

export function loadConfig() {
  const local = loadLocalConfig();
  const feishu = local.feishu || {};
  const tables = feishu.tables || {};
  return {
    operator: process.env.BOSS_OPERATOR || local.operator || process.env.USER || "unknown",
    feishu: {
      appId: pick(feishu.app_id, "FEISHU_APP_ID"),
      appSecret: pick(feishu.app_secret, "FEISHU_APP_SECRET"),
      appToken: pick(feishu.app_token, "FEISHU_APP_TOKEN"),
      tables: {
        taskConfig: pick(tables.task_config || tables.job_rules, "FEISHU_TABLE_TASK_CONFIG"),
        scoreRules: pick(tables.score_rules, "FEISHU_TABLE_SCORE_RULES"),
        thresholds: pick(tables.thresholds, "FEISHU_TABLE_THRESHOLDS"),
        taskRecords: pick(tables.task_records, "FEISHU_TABLE_TASK_RECORDS"),
        greetRecords: pick(tables.greet_records || tables.interaction_log, "FEISHU_TABLE_GREET_RECORDS"),
      },
    },
  };
}

function assertConfig(config, names = ["taskConfig"]) {
  const missing = [
    ["FEISHU_APP_ID", config.feishu.appId],
    ["FEISHU_APP_SECRET", config.feishu.appSecret],
    ["FEISHU_APP_TOKEN", config.feishu.appToken],
    ...names.map((name) => [`FEISHU_TABLE_${name.replace(/[A-Z]/g, (m) => `_${m}`).toUpperCase()}`, config.feishu.tables[name]]),
  ];
  const empty = missing.filter(([, value]) => !value).map(([name]) => name);
  if (empty.length) throw new Error(`缺少飞书配置: ${empty.join(", ")}`);
}

async function readJson(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

async function tenantAccessToken(config) {
  assertConfig(config, []);
  const now = Date.now() / 1000;
  if (tokenCache.token && now < tokenCache.expireAt - 60) return tokenCache.token;

  const response = await fetch(`${BASE_URL}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: config.feishu.appId, app_secret: config.feishu.appSecret }),
  });
  const data = await readJson(response);
  if (data.code !== 0) throw new Error(`飞书 Token 获取失败: ${JSON.stringify(data)}`);
  tokenCache = { token: data.tenant_access_token, expireAt: now + Number(data.expire || 7200) };
  return tokenCache.token;
}

async function headers(config) {
  return {
    Authorization: `Bearer ${await tenantAccessToken(config)}`,
    "Content-Type": "application/json",
  };
}

function unwrap(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item.text === "string") return item.text;
        if (item && typeof item.name === "string") return item.name;
        if (item && typeof item.en_name === "string") return item.en_name;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (value == null) return "";
  if (typeof value === "object" && typeof value.text === "string") return value.text;
  return String(value);
}

function first(fields, ...names) {
  for (const name of names) {
    const value = unwrap(fields?.[name]).trim();
    if (value) return value;
  }
  return "";
}

function splitList(value) {
  return unwrap(value)
    .split(/\r?\n|,|，|、|;/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function list(fields, ...names) {
  return splitList(names.map((name) => fields?.[name]).find((value) => unwrap(value).trim()));
}

function boolField(value) {
  if (value === true) return true;
  if (value === false || value == null) return false;
  const text = unwrap(value).trim().toLowerCase();
  return ["true", "yes", "y", "1", "是", "启用", "允许", "开启"].includes(text);
}

function numberField(fields, fallback, ...names) {
  for (const name of names) {
    const raw = unwrap(fields?.[name]).trim();
    if (!raw) continue;
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function normalizeKey(value) {
  return String(value || "").replace(/\s+/g, "").toLowerCase();
}

function taskKey(city, jobType) {
  return [city, jobType].filter(Boolean).join("");
}

function parseTask(record) {
  const fields = record.fields || {};
  const city = first(fields, "城市");
  const jobType = first(fields, "岗位类型") || "销售";
  const target = numberField(fields, 0, "招呼量", "招呼任务量", "单轮最大打招呼数");
  const completedToday = numberField(fields, 0, "今日已完成");
  const remainingToday = fields["今日剩余"] == null ? Math.max(0, target - completedToday) : numberField(fields, 0, "今日剩余");
  const enabled = boolField(fields["是否启用"] ?? fields["启用"]);
  return {
    recordId: record.record_id,
    jobKey: taskKey(city, jobType),
    jobName: first(fields, "岗位名称") || `${city}${jobType}`,
    bossJobName: first(fields, "BOSS岗位匹配名", "BOSS职位名") || city,
    city,
    cityType: first(fields, "城市类型"),
    jobType,
    enabled,
    allowAutoGreet: true,
    vipFilters: {
      activity: first(fields, "筛选标准-活跃度", "页面筛选活跃度", "VIP筛选活跃度"),
      recentUnviewed: first(fields, "筛选标准-是否与同事交换简历", "近期未看过", "最近未看过"),
      areas: list(fields, "细分区域"),
      experience: list(fields, "页面筛选经验", "VIP筛选经验"),
      education: list(fields, "页面筛选学历", "VIP筛选学历"),
      school: list(fields, "页面筛选院校", "VIP筛选院校"),
      keywords: list(fields, "页面筛选关键词", "VIP筛选关键词"),
    },
    hardFilters: {
      cities: [city].filter(Boolean),
      minAge: numberField(fields, 0, "筛选标准-最低年龄", "硬筛最低年龄", "最低年龄"),
      maxAge: numberField(fields, 99, "筛选标准-最高年龄", "硬筛最高年龄", "最高年龄"),
      minExperienceYears: numberField(fields, 0, "硬筛经验最小", "经验最小"),
      maxExperienceYears: numberField(fields, 99, "硬筛经验最大", "经验最大"),
      education: list(fields, "硬筛学历", "学历要求"),
      schools: list(fields, "硬筛学校", "学校要求"),
      skills: list(fields, "技能关键词", "技能要求"),
      skillMatchMode: first(fields, "技能匹配模式") || "包含任一",
      excludeKeywords: list(fields, "排除关键词", "排除词"),
      targetCompanies: list(fields, "目标公司", "目标公司/行业"),
      companyMatchMode: first(fields, "公司匹配模式") || "加分",
    },
    scoring: { threshold: 0 },
    limits: {
      scanBatchSize: numberField(fields, 15, "单批扫描人数"),
      maxGreetsPerBatch: numberField(fields, 3, "单批最大打招呼数"),
      maxGreetsPerRun: Math.max(0, Math.min(target, remainingToday)),
    },
    progress: {
      target,
      completedToday,
      remainingToday,
      status: first(fields, "任务状态"),
      updatedAt: first(fields, "最后更新时间"),
    },
    rawFields: fields,
  };
}

function parseScoreRule(record) {
  const fields = record.fields || {};
  return {
    recordId: record.record_id,
    name: first(fields, "规则名称"),
    jobType: first(fields, "岗位类型"),
    cities: list(fields, "城市"),
    enabled: boolField(fields["是否启用"]),
    ruleType: first(fields, "规则类型"),
    targetField: first(fields, "作用字段") || "全文",
    score: numberField(fields, 0, "分值"),
    mainKeywords: splitList(fields["正向词"] ?? fields["主关键词"]),
    secondaryKeywords: splitList(fields["排除词"] ?? fields["副关键词"]),
    matchMode: first(fields, "匹配方式") || "包含任一",
    scoreMode: first(fields, "计分方式") || "命中任一一次性加分",
    minTenureMonths: numberField(fields, 0, "在职时长大于等于(月)"),
    recentGapMonths: numberField(fields, 0, "最近工作结束间隔大于(月)"),
    note: first(fields, "备注"),
  };
}

function parseThreshold(record) {
  const fields = record.fields || {};
  return {
    recordId: record.record_id,
    jobType: first(fields, "岗位类型", "文本"),
    cities: list(fields, "城市"),
    enabled: boolField(fields["是否启用"]),
    threshold: numberField(fields, 0, "通过阈值", "评分阈值"),
    version: first(fields, "规则版本"),
    description: first(fields, "规则说明"),
  };
}

async function searchRecords(config, tableId) {
  const records = [];
  let pageToken = "";
  while (true) {
    const body = { page_size: 500 };
    if (pageToken) body.page_token = pageToken;
    const response = await fetch(`${BASE_URL}/bitable/v1/apps/${config.feishu.appToken}/tables/${tableId}/records/search`, {
      method: "POST",
      headers: await headers(config),
      body: JSON.stringify(body),
    });
    const data = await readJson(response);
    if (data.code !== 0) throw new Error(`读取飞书记录失败 table=${tableId}: ${JSON.stringify(data)}`);
    records.push(...(data.data?.items || []));
    if (!data.data?.has_more) break;
    pageToken = data.data?.page_token || "";
  }
  return records;
}

async function createRecords(config, tableId, records) {
  if (!records.length) return { ok: true, count: 0 };
  let count = 0;
  for (let index = 0; index < records.length; index += 500) {
    const chunk = records.slice(index, index + 500);
    const response = await fetch(`${BASE_URL}/bitable/v1/apps/${config.feishu.appToken}/tables/${tableId}/records/batch_create`, {
      method: "POST",
      headers: await headers(config),
      body: JSON.stringify({ records: chunk.map((fields) => ({ fields })) }),
    });
    const data = await readJson(response);
    if (data.code !== 0) throw new Error(`写入飞书记录失败 table=${tableId}: ${JSON.stringify(data)}`);
    count += chunk.length;
  }
  return { ok: true, count };
}

async function updateRecord(config, tableId, recordId, fields) {
  const response = await fetch(`${BASE_URL}/bitable/v1/apps/${config.feishu.appToken}/tables/${tableId}/records/${recordId}`, {
    method: "PUT",
    headers: await headers(config),
    body: JSON.stringify({ fields }),
  });
  const data = await readJson(response);
  if (data.code !== 0) throw new Error(`更新飞书记录失败 table=${tableId}: ${JSON.stringify(data)}`);
  return { ok: true };
}

function cityMatches(ruleCities, city) {
  if (!ruleCities.length) return false;
  const target = normalizeKey(city);
  return ruleCities.some((item) => normalizeKey(item) === target);
}

function scopeMatches(item, task) {
  if (item.jobType && normalizeKey(item.jobType) !== normalizeKey(task.jobType)) return false;
  return !item.cities?.length || cityMatches(item.cities, task.city);
}

export async function listJobRules() {
  const config = loadConfig();
  assertConfig(config, ["taskConfig", "scoreRules", "thresholds"]);
  const tasks = (await searchRecords(config, config.feishu.tables.taskConfig)).map(parseTask);
  const thresholds = (await searchRecords(config, config.feishu.tables.thresholds)).map(parseThreshold).filter((item) => item.enabled);
  const scoreRules = (await searchRecords(config, config.feishu.tables.scoreRules)).map(parseScoreRule).filter((item) => item.enabled);
  return tasks.map((task) => attachPolicy(task, thresholds, scoreRules));
}

function attachPolicy(task, thresholds, scoreRules) {
  const cityThreshold = thresholds.find((item) => scopeMatches(item, task) && cityMatches(item.cities, task.city));
  const genericThreshold = thresholds.find((item) => scopeMatches(item, task) && !item.cities.length);
  const threshold = cityThreshold || genericThreshold;
  return {
    ...task,
    scoring: {
      threshold: threshold?.threshold ?? 0,
      thresholdRecordId: threshold?.recordId || "",
      thresholdVersion: threshold?.version || "",
      thresholdDescription: threshold?.description || "",
    },
    scoreRules: scoreRules.filter((item) => scopeMatches(item, task)),
  };
}

export async function listEnabledTasks() {
  return (await listJobRules()).filter((task) => task.enabled && task.limits.maxGreetsPerRun > 0);
}

export async function loadJobRule(jobKey) {
  const normalized = normalizeKey(jobKey);
  const rules = (await listJobRules()).filter((rule) => normalizeKey(rule.jobKey) === normalized);
  if (rules.length === 0) throw new Error(`飞书未找到任务: ${jobKey}`);
  if (rules.length > 1) throw new Error(`飞书任务不唯一: ${jobKey}，命中 ${rules.length} 条`);
  const rule = rules[0];
  if (!rule.enabled) throw new Error(`任务未启用: ${jobKey}`);
  return rule;
}

export async function testFeishuConnection() {
  const config = loadConfig();
  assertConfig(config, ["taskConfig", "scoreRules", "thresholds"]);
  const rules = await listJobRules();
  return {
    ok: true,
    tasks: rules.length,
    enabledTasks: rules.filter((rule) => rule.enabled).length,
    executableTasks: rules.filter((rule) => rule.enabled && rule.limits.maxGreetsPerRun > 0).length,
    scoreRules: rules.reduce((sum, rule) => sum + rule.scoreRules.length, 0),
  };
}

function nowText() {
  return new Date().toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });
}

export async function updateTaskProgress(rule, summary) {
  const config = loadConfig();
  assertConfig(config, ["taskConfig"]);
  const completed = rule.progress.completedToday + Number(summary.greeted || 0);
  const remaining = Math.max(0, rule.progress.target - completed);
  return updateRecord(config, config.feishu.tables.taskConfig, rule.recordId, {
    今日已完成: completed,
    今日剩余: remaining,
    任务状态: summary.status,
    最后更新时间: nowText(),
  });
}

export async function writeTaskRecord(rule, summary) {
  const config = loadConfig();
  if (!config.feishu.tables.taskRecords) return { ok: true, skipped: true };
  assertConfig(config, ["taskRecords"]);
  const startedAt = summary.startedAt || Date.now();
  const endedAt = summary.endedAt || Date.now();
  const duration = Math.max(0, Math.round((endedAt - startedAt) / 1000));
  const greeted = Number(summary.greeted || 0);
  const seen = Number(summary.seen || 0);
  return createRecords(config, config.feishu.tables.taskRecords, [{
    批次ID: summary.runId,
    岗位类型: rule.jobType,
    岗位名称: summary.pageJobName || rule.jobName,
    开始时间: startedAt,
    结束时间: endedAt,
    总耗时秒: duration,
    目标数: rule.progress.target,
    总浏览数: seen,
    打招呼数: greeted,
    失败数: Number(summary.failed || 0),
    跳过数: Number(summary.skipped || 0),
    打招呼率: seen ? Number(((greeted / seen) * 100).toFixed(1)) : 0,
    招呼浏览比: greeted ? Number((seen / greeted).toFixed(2)) : 0,
    最终状态: summary.status,
    停止原因: summary.stopReason || "",
    备注: summary.note || "",
  }]);
}

export async function writeGreetRecords(rule, records) {
  const config = loadConfig();
  if (!config.feishu.tables.greetRecords) return { ok: true, skipped: true };
  assertConfig(config, ["greetRecords"]);
  return createRecords(config, config.feishu.tables.greetRecords, records.map((record, index) => ({
    批次ID: record.runId,
    交互日期: record.actionTime || Date.now(),
    岗位类型: rule.jobType,
    城市: rule.city,
    岗位名称: record.pageJobName || rule.jobName,
    姓名: record.name || record.candidateName || "",
    动作类型: "打招呼",
    动作结果: record.action === "greeted" ? "成功" : "失败",
    动作序号: record.actionIndex || index + 1,
    匹配分数: Number(record.score || 0),
    命中规则: (record.matchedRules || record.matched || []).join("；"),
    命中关键词: (record.matchedKeywords || []).join("；"),
    失败原因: record.action === "greeted" ? "" : (record.result || (record.reasons || []).join("；")),
    备注: record.note || "",
  })));
}

export async function writeRunResult(rule, summary, records) {
  const taskUpdate = await updateTaskProgress(rule, summary);
  const taskRecord = await writeTaskRecord(rule, summary);
  const greetRecords = await writeGreetRecords(rule, records.filter((record) => record.action === "greeted" || record.action === "failed"));
  return { taskUpdate, taskRecord, greetRecords };
}
