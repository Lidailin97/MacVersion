function normalize(text) {
  return String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function compactForMatch(text) {
  return normalize(text).replace(/[\s"'“”‘’`·.。,:：;；|｜/\\\-_[\]()（）{}【】<>《》]+/g, "");
}

function includesAny(text, values) {
  const source = compactForMatch(text);
  return values.some((value) => {
    const keyword = compactForMatch(value);
    return keyword && source.includes(keyword);
  });
}

function includesAll(text, values) {
  const source = compactForMatch(text);
  return values.every((value) => {
    const keyword = compactForMatch(value);
    return keyword && source.includes(keyword);
  });
}

function keywordHits(text, values) {
  const source = compactForMatch(text);
  return values.filter((value) => {
    const keyword = compactForMatch(value);
    return keyword && source.includes(keyword);
  });
}

function monthIndex(year, month) {
  return Number(year) * 12 + Number(month || 1);
}

function durationMonths(text) {
  const source = normalize(text);
  const explicit = source.match(/(\d+)\s*年\s*(\d+)?\s*个?月?/);
  if (explicit) return Number(explicit[1]) * 12 + Number(explicit[2] || 0);

  const dates = Array.from(source.matchAll(/(20\d{2}|19\d{2})(?:[./年-]\s*(\d{1,2}))?/g));
  if (!dates.length) return null;

  const start = dates[0];
  const startMonth = monthIndex(start[1], start[2] || 1);
  let endMonth = null;
  if (/至今|现在|目前|在职/.test(source)) {
    const now = new Date();
    endMonth = monthIndex(now.getFullYear(), now.getMonth() + 1);
  } else if (dates.length >= 2) {
    const end = dates[1];
    endMonth = monthIndex(end[1], end[2] || 12);
  }

  if (endMonth == null || endMonth < startMonth) return null;
  return endMonth - startMonth + 1;
}

function monthsSinceEnd(text) {
  const source = normalize(text);
  if (/至今|现在|目前|在职/.test(source)) return 0;
  const dates = Array.from(source.matchAll(/(20\d{2}|19\d{2})(?:[./年-]\s*(\d{1,2}))?/g));
  if (!dates.length) return null;
  const end = dates[dates.length - 1];
  const endMonth = monthIndex(end[1], end[2] || 12);
  const now = new Date();
  return Math.max(0, monthIndex(now.getFullYear(), now.getMonth() + 1) - endMonth);
}

function educationRank(text) {
  const value = normalize(text);
  if (value.includes("博士")) return 4;
  if (value.includes("硕士")) return 3;
  if (value.includes("本科")) return 2;
  if (value.includes("大专")) return 1;
  return 0;
}

function requiredEducationRank(values) {
  if (!values.length) return 0;
  return Math.min(...values.map(educationRank).filter((rank) => rank > 0));
}

function schoolScore(text, rule) {
  const schools = rule.hardFilters.schools || [];
  const source = normalize(text);
  if (/qs\s*top?\s*50|top\s*50|c9|清华|北大|复旦|上交|浙大|中科大|南大|哈工大|西交/.test(source)) {
    return rule.scoring.weights.school;
  }
  if (/qs\s*100|top\s*100|985|国内外名校/.test(source) || includesAny(source, schools)) {
    return Math.round(rule.scoring.weights.school * 0.8);
  }
  if (/211|硕士|博士/.test(source)) return Math.round(rule.scoring.weights.school * 0.5);
  return 0;
}

function activityScore(text, rule) {
  const source = normalize(text);
  const weight = rule.scoring.weights.activity;
  if (/刚刚活跃|在线/.test(source)) return weight;
  if (/今日活跃|今天/.test(source)) return Math.round(weight * 0.75);
  if (/本周|近7天/.test(source)) return Math.round(weight * 0.5);
  return Math.round(weight * 0.3);
}

function companyScore(text, rule) {
  const companies = rule.hardFilters.targetCompanies || [];
  if (!companies.length) return 0;
  if (includesAny(text, companies)) return rule.scoring.weights.company;
  return 0;
}

function skillScore(text, rule) {
  const skills = rule.hardFilters.skills || [];
  if (!skills.length) return rule.scoring.weights.skill;
  const hit = rule.hardFilters.skillMatchMode === "包含全部" ? includesAll(text, skills) : includesAny(text, skills);
  return hit ? rule.scoring.weights.skill : 0;
}

function targetText(candidate, targetField) {
  const field = normalize(targetField);
  if (field.includes("经历") || field.includes("工作") || field.includes("公司")) return candidate.resume || candidate.fullText || "";
  if (field.includes("期望")) return candidate.title || candidate.fullText || "";
  if (field.includes("基础") || field.includes("年龄") || field.includes("学历")) return candidate.baseInfo || candidate.fullText || "";
  return [candidate.name, candidate.title, candidate.baseInfo, candidate.resume, candidate.fullText].join(" ");
}

function experienceSegments(candidate, fallbackText) {
  const segments = Array.isArray(candidate.experienceSegments) ? candidate.experienceSegments.filter(Boolean) : [];
  return segments.length ? segments : [fallbackText].filter(Boolean);
}

function segmentSatisfiesTiming(segment, scoreRule) {
  const minTenure = Number(scoreRule.minTenureMonths || 0);
  if (minTenure > 0) {
    const months = durationMonths(segment);
    if (months == null || months < minTenure) return false;
  }

  const recentGap = Number(scoreRule.recentGapMonths || 0);
  if (recentGap > 0) {
    const gap = monthsSinceEnd(segment);
    if (gap == null || gap < recentGap) return false;
  }

  return true;
}

function isHardFilterRule(scoreRule) {
  return /硬过滤|直接过滤/.test(`${scoreRule.ruleType} ${scoreRule.matchMode} ${scoreRule.scoreMode}`);
}

function keywordRuleMatched(text, scoreRule) {
  const mainKeywords = scoreRule.mainKeywords || [];
  const secondaryKeywords = scoreRule.secondaryKeywords || [];
  const keywords = isHardFilterRule(scoreRule) ? [...mainKeywords, ...secondaryKeywords] : mainKeywords;
  if (!keywords.length) return { matched: false, hits: [] };

  const blockedHits = isHardFilterRule(scoreRule) ? [] : keywordHits(text, secondaryKeywords);
  if (blockedHits.length) return { matched: false, hits: [], blockedHits };

  const hits = keywordHits(text, keywords);
  const mode = scoreRule.matchMode || "";
  if (/全部/.test(mode)) return { matched: keywords.length > 0 && hits.length === keywords.length, hits };
  return { matched: hits.length > 0, hits };
}

function ruleMatched(candidate, text, scoreRule) {
  const requiresTiming = Number(scoreRule.minTenureMonths || 0) > 0 || Number(scoreRule.recentGapMonths || 0) > 0;
  if (!requiresTiming) return keywordRuleMatched(text, scoreRule);

  const segments = experienceSegments(candidate, text);
  for (const segment of segments) {
    const hit = keywordRuleMatched(segment, scoreRule);
    if (!hit.matched) continue;
    if (!segmentSatisfiesTiming(segment, scoreRule)) continue;
    return {
      ...hit,
      tenureMonths: durationMonths(segment),
      recentGapMonths: monthsSinceEnd(segment),
    };
  }
  return { matched: false, hits: [] };
}

function ruleScore(scoreRule, hitCount) {
  const base = Number(scoreRule.score || 0);
  if (/每命中一个/.test(scoreRule.scoreMode || "")) return base * Math.max(1, hitCount);
  return base;
}

function applyConfiguredRules(candidate, rule, reasons, matched, matchedRules, matchedKeywords) {
  let score = 0;
  const rules = rule.scoreRules || [];
  for (const scoreRule of rules) {
    const text = targetText(candidate, scoreRule.targetField);
    const hit = ruleMatched(candidate, text, scoreRule);
    if (!hit.matched) continue;

    matchedRules.push(scoreRule.name || scoreRule.ruleType || "未命名规则");
    matchedKeywords.push(...hit.hits);

    if (isHardFilterRule(scoreRule)) {
      reasons.push(`命中硬过滤:${scoreRule.name || hit.hits.join("/")}`);
      continue;
    }

    const delta = ruleScore(scoreRule, hit.hits.length);
    score += delta;
    const tenureText = hit.tenureMonths != null ? `,在职${hit.tenureMonths}月` : "";
    matched.push(`${scoreRule.name || "规则"}:${delta}${tenureText}`);
  }
  return score;
}

export function scoreCandidate(candidate, rule) {
  const reasons = [];
  const matched = [];
  const matchedRules = [];
  const matchedKeywords = [];
  const text = [candidate.name, candidate.title, candidate.baseInfo, candidate.resume, candidate.fullText].join(" ");

  if (candidate.buttonText === "继续沟通") reasons.push("已沟通过");
  if (candidate.buttonText !== "打招呼") reasons.push(`按钮不可打招呼:${candidate.buttonText || "空"}`);

  const excludes = rule.hardFilters.excludeKeywords || [];
  if (excludes.length && includesAny(text, excludes)) reasons.push("命中排除关键词");

  const cities = rule.hardFilters.cities || [];
  if (cities.length && !includesAny(text, cities)) reasons.push("城市不匹配");

  const years = candidate.years;
  const age = candidate.age;
  if (age != null) {
    if (age < rule.hardFilters.minAge) reasons.push("年龄低于要求");
    if (age > rule.hardFilters.maxAge) reasons.push("年龄高于要求");
  }

  if (years != null) {
    if (years < rule.hardFilters.minExperienceYears) reasons.push("经验低于要求");
    if (years > rule.hardFilters.maxExperienceYears) reasons.push("经验高于要求");
  }

  const requiredEdu = requiredEducationRank(rule.hardFilters.education || []);
  if (requiredEdu > 0 && educationRank(text) > 0 && educationRank(text) < requiredEdu) reasons.push("学历不匹配");

  const skills = rule.hardFilters.skills || [];
  if (skills.length) {
    const skillHit = rule.hardFilters.skillMatchMode === "包含全部" ? includesAll(text, skills) : includesAny(text, skills);
    if (!skillHit) reasons.push("技能关键词不匹配");
    else matched.push("技能关键词");
  }

  const companies = rule.hardFilters.targetCompanies || [];
  if (companies.length && includesAny(text, companies)) matched.push("目标公司");
  if (companies.length && rule.hardFilters.companyMatchMode === "硬性" && !includesAny(text, companies)) {
    reasons.push("目标公司不匹配");
  }

  const schools = rule.hardFilters.schools || [];
  if (schools.length && includesAny(text, schools)) matched.push("学校要求");

  const configuredScore = applyConfiguredRules(candidate, rule, reasons, matched, matchedRules, matchedKeywords);
  const score = (rule.scoreRules || []).length
    ? configuredScore
    : schoolScore(text, rule) + companyScore(text, rule) + skillScore(text, rule) + activityScore(text, rule);

  const pass = reasons.length === 0 && score >= rule.scoring.threshold;
  if (!pass && reasons.length === 0) reasons.push("分数低于阈值");

  return {
    ...candidate,
    score,
    pass,
    reasons,
    matched,
    matchedRules,
    matchedKeywords: Array.from(new Set(matchedKeywords)),
  };
}

export function rankCandidates(candidates, rule) {
  return candidates
    .map((candidate) => scoreCandidate(candidate, rule))
    .sort((left, right) => {
      if (left.pass !== right.pass) return left.pass ? -1 : 1;
      return right.score - left.score;
    });
}
