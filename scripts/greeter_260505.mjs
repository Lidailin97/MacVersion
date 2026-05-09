import { inspectPage, assertReadyPage, readCurrentJobName, switchJobByCity, applyVipFilters, scanCandidates, clickGreet, verifyGreet, scrollForMore, refreshRecommendPool } from "./boss_page_adapter.mjs";
import { listEnabledTasks, loadJobRule, testFeishuConnection, writeRunResult } from "./feishu_rules.mjs";
import { rankCandidates } from "./scorer.mjs";
import { clearStop, runId, saveState, shouldStop, writePid } from "./run_state.mjs";

function normalize(text) {
  return String(text || "").replace(/\s+/g, "").toLowerCase();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(rule) {
  const min = 3;
  const max = 5;
  return Math.round((min + Math.random() * (max - min)) * 1000);
}

function assertJobMatches(pageJobName, rule) {
  const expected = normalize(rule.city || rule.bossJobName || rule.jobName || rule.jobKey);
  const current = normalize(pageJobName);
  if (!expected || !current || !current.includes(expected)) {
    throw new Error(`当前 BOSS 岗位与飞书任务不匹配: 当前="${pageJobName}" 期望城市="${rule.city}"`);
  }
}

function summarizeRanked(ranked) {
  return ranked.map((item, index) => ({
    rank: index + 1,
    name: item.name,
    score: item.score,
    pass: item.pass,
    buttonText: item.buttonText,
    reasons: item.reasons,
    matched: item.matched,
    fingerprint: item.fingerprint,
  }));
}

function summarizePolicy(rule) {
  return {
    city: rule.city,
    jobType: rule.jobType,
    threshold: rule.scoring.threshold,
    thresholdVersion: rule.scoring.thresholdVersion,
    thresholdDescription: rule.scoring.thresholdDescription,
    scoreRuleCount: (rule.scoreRules || []).length,
    tenureRuleCount: (rule.scoreRules || []).filter((item) => Number(item.minTenureMonths || 0) > 0).length,
    recentGapRuleCount: (rule.scoreRules || []).filter((item) => Number(item.recentGapMonths || 0) > 0).length,
  };
}

async function loadContext(jobKey) {
  const page = assertReadyPage();
  const rule = await loadJobRule(jobKey);
  const manualSetup = process.env.BOSS_AUTO_SETUP !== "1";
  const switchResult = manualSetup
    ? { attempted: false, skipped: true, reason: "manual_setup" }
    : switchJobByCity(rule.city);
  if (!manualSetup && switchResult.reason) throw new Error(`切换岗位失败: ${switchResult.reason}`);
  if (!manualSetup && switchResult.switched) await sleep(3000);
  assertReadyPage();
  const pageJobName = readCurrentJobName();
  assertJobMatches(pageJobName, rule);
  return { page, rule, pageJobName, switchResult };
}

async function cmdInspect() {
  console.log(JSON.stringify({ page: inspectPage(), jobName: readCurrentJobName() }, null, 2));
}

async function cmdFeishuTest() {
  console.log(JSON.stringify(await testFeishuConnection(), null, 2));
}

async function cmdDryRun(jobKey) {
  writePid();
  clearStop();
  const { rule, pageJobName } = await loadContext(jobKey);
  const id = runId(rule.city, rule.jobType);
  const filterResult = process.env.BOSS_AUTO_SETUP !== "1"
    ? { attempted: false, skipped: true, reason: "manual_setup" }
    : applyVipFilters(rule);
  await sleep(1500);
  const scan = scanCandidates(rule.limits.scanBatchSize);
  if (scan.hardStop) throw new Error(`检测到风控/异常信号: ${scan.hardStopText}`);
  const ranked = rankCandidates(scan.cards, rule);
  const summary = {
    runId: id,
    mode: "dry-run",
    jobKey,
    pageJobName,
    policy: summarizePolicy(rule),
    filterResult,
    scanned: scan.cards.length,
    passCount: ranked.filter((item) => item.pass).length,
    candidates: summarizeRanked(ranked),
  };
  saveState(summary);
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

async function cmdAutoGreet(jobKey, limitOverride = 0) {
  const startedAt = Date.now();
  writePid();
  clearStop();
  const { rule, pageJobName, switchResult } = await loadContext(jobKey);
  const id = runId(rule.city, rule.jobType);
  if (!rule.allowAutoGreet) throw new Error(`飞书规则未允许自动点击: ${jobKey}`);
  if (limitOverride > 0) {
    rule.limits.maxGreetsPerRun = Math.min(rule.limits.maxGreetsPerRun, limitOverride);
    rule.limits.maxGreetsPerBatch = Math.min(rule.limits.maxGreetsPerBatch, limitOverride);
  }
  if (rule.limits.maxGreetsPerRun <= 0) throw new Error(`飞书规则单轮最大打招呼数为 0: ${jobKey}`);

  const filterResult = process.env.BOSS_AUTO_SETUP !== "1"
    ? { attempted: false, skipped: true, reason: "manual_setup" }
    : applyVipFilters(rule);
  await sleep(1500);

  let greeted = 0;
  let seen = 0;
  let skipped = 0;
  let failed = 0;
  let noProgressRounds = 0;
  let refreshes = 0;
  const maxRefreshes = 3;
  let stopReason = "";
  const clickedFingerprints = new Set();
  const records = [];

  while (greeted < rule.limits.maxGreetsPerRun) {
    if (shouldStop()) break;
    const scan = scanCandidates(rule.limits.scanBatchSize);
    if (scan.hardStop) throw new Error(`检测到风控/异常信号: ${scan.hardStopText}`);
    seen += scan.cards.length;

    const ranked = rankCandidates(scan.cards, rule);
    const targets = ranked
      .filter((item) => item.pass && !clickedFingerprints.has(item.fingerprint))
      .slice(0, Math.min(rule.limits.maxGreetsPerBatch, rule.limits.maxGreetsPerRun - greeted));

    for (const target of targets) {
      if (shouldStop()) break;
      const click = clickGreet(target);
      if (!click.ok) {
        failed++;
        records.push({ runId: id, jobKey, ...target, action: "failed", result: click.reason || "click_failed" });
        if (click.hardStop) throw new Error(`检测到风控/异常信号: ${click.reason}`);
        continue;
      }
      clickedFingerprints.add(target.fingerprint);
      await sleep(randomDelay(rule));
      const verify = verifyGreet(target);
      if (verify.hardStop) throw new Error(`检测到风控/异常信号: ${verify.hardStopText}`);
      if (!verify.success) {
        failed++;
        records.push({ runId: id, jobKey, ...target, action: "failed", result: `verify_failed:${verify.buttonText}` });
        throw new Error(`点击后状态未确认，已停止避免重复点击: ${target.name}`);
      }
      greeted++;
      records.push({ runId: id, jobKey, pageJobName, ...target, action: "greeted", result: "成功", actionTime: Date.now() });
      saveState({ runId: id, mode: "auto-greet", jobKey, pageJobName, greeted, failed, seen, skipped });
      if (greeted >= rule.limits.maxGreetsPerRun) break;
    }

    skipped += ranked.filter((item) => !item.pass).length;
    if (targets.length === 0) {
      scrollForMore();
      noProgressRounds += 1;
      if (noProgressRounds >= 10) {
        if (refreshes >= maxRefreshes) {
          stopReason = `刷新推荐池${refreshes}次后仍连续${noProgressRounds}轮未找到可打候选人或页面无更多进展`;
          break;
        }
        const refresh = refreshRecommendPool();
        if (refresh.hardStop) throw new Error(`检测到风控/异常信号: ${refresh.reason}`);
        if (!refresh.ok) {
          stopReason = `刷新推荐池失败:${refresh.reason || "unknown"}`;
          break;
        }
        refreshes++;
        noProgressRounds = 0;
        saveState({ runId: id, mode: "auto-greet", jobKey, pageJobName, greeted, failed, seen, skipped, refreshes });
        await sleep(3000);
        assertReadyPage();
        continue;
      }
      await sleep(2000);
    } else {
      noProgressRounds = 0;
    }
  }

  const projectedCompletedToday = rule.progress.completedToday + greeted;
  const status = projectedCompletedToday >= rule.progress.target ? "已完成" : "提前结束";
  const summary = {
    runId: id,
    mode: "auto-greet",
    jobKey,
    pageJobName,
    policy: summarizePolicy(rule),
    switchResult,
    filterResult,
    greeted,
    failed,
    seen,
    skipped,
    refreshes,
    status,
    stopReason: status === "已完成" ? "" : (shouldStop() ? "用户手动停止" : stopReason || `刷新推荐池${refreshes}次后仍连续${noProgressRounds}轮未找到可打候选人或页面无更多进展`),
    startedAt,
    endedAt: Date.now(),
  };
  const writeResult = await writeRunResult(rule, summary, records);
  const output = {
    ...summary,
    writeResult,
  };
  saveState(output);
  console.log(JSON.stringify(output, null, 2));
  return output;
}

async function cmdRunTask(jobKey, limitOverride = 0) {
  const dryRunSummary = await cmdDryRun(jobKey);
  if (dryRunSummary.passCount <= 0) {
    console.log(JSON.stringify({
      mode: "run-task",
      jobKey,
      status: "dry-run-passed-no-targets",
      message: "dry-run 校验通过，但当前可见候选人暂未命中；继续进入 auto-greet，由滚动和推荐池刷新逻辑寻找后续候选人。",
      dryRun: {
        runId: dryRunSummary.runId,
        scanned: dryRunSummary.scanned,
        passCount: dryRunSummary.passCount,
      },
    }, null, 2));
  }
  return cmdAutoGreet(jobKey, limitOverride);
}

async function cmdAutoGreetEnabled() {
  const tasks = await listEnabledTasks();
  const results = [];
  for (const task of tasks) {
    results.push(await cmdAutoGreet(task.jobKey));
  }
  return results;
}

const [, , command, jobKey, limitArg] = process.argv;

try {
  switch (command) {
    case "inspect":
      await cmdInspect();
      break;
    case "feishu-test":
      await cmdFeishuTest();
      break;
    case "dry-run":
      if (!jobKey) throw new Error("缺少任务目标，例如：惠州销售");
      await cmdDryRun(jobKey);
      break;
    case "auto-greet":
      if (!jobKey) throw new Error("缺少任务目标，例如：惠州销售");
      await cmdAutoGreet(jobKey, Number(limitArg || 0));
      break;
    case "run-task":
      if (!jobKey) throw new Error("缺少任务目标，例如：惠州销售");
      await cmdRunTask(jobKey, Number(limitArg || 0));
      break;
    case "auto-greet-enabled":
      await cmdAutoGreetEnabled();
      break;
    default:
      console.log(`用法:
  node scripts/greeter_260505.mjs inspect
  node scripts/greeter_260505.mjs feishu-test
  node scripts/greeter_260505.mjs dry-run <城市+岗位类型>
  node scripts/greeter_260505.mjs run-task <城市+岗位类型> [本次上限]
  node scripts/greeter_260505.mjs auto-greet <城市+岗位类型> [本次上限]
  node scripts/greeter_260505.mjs auto-greet-enabled`);
  }
} catch (error) {
  saveState({ error: error.message, stack: error.stack, command, jobKey, time: new Date().toISOString() });
  console.error(error.message);
  process.exit(1);
}
