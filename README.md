# MacVersion

Mac 版 BOSS 直聘飞书规则主动打招呼 skill。

这个仓库是 Mac/有头 Chrome/AppleScript 版本，和旧 Windows 倾向版本区分开维护。

核心设计：

- 复用当前已登录的有头 Chrome
- 不使用无头、CDP、Puppeteer、独立 Profile
- 默认由用户手动切好岗位并设置筛选，skill 只接管已准备好的推荐页
- 飞书读取任务配置、评分阈值、赋分标准和打招呼上限
- 单 BOSS 页签；多个页签时停止
- 当前 BOSS 岗位城市必须与任务城市一致；不一致则停止提醒
- 符合标准才自动点击，点击后校验 `继续沟通`
- 出现风控、上限、验证码、频率提示立即停止，并在输出和本地状态中保留完整警告内容

## 配置

复制配置：

```bash
cp config.private.example.json config.private.json
```

填写：

- `feishu.app_id`
- `feishu.app_secret`
- `feishu.app_token`
- `feishu.tables.task_config`
- `feishu.tables.score_rules`
- `feishu.tables.thresholds`
- `feishu.tables.task_records`
- `feishu.tables.greet_records`

## 命令

```bash
npm run check-chrome
npm run feishu-test
npm run inspect
npm run dry-run -- <城市+岗位类型>
npm run run-task -- <城市+岗位类型>
npm run auto-greet -- <城市+岗位类型>
npm run auto-greet-enabled
npm run stop
```

## 推荐试跑顺序

1. 打开已登录 BOSS 的 Chrome，并只保留一个 BOSS 页签。
2. 手动进入 BOSS 的目标岗位 `推荐牛人` 页面，并手动设置好筛选。
3. 执行 `npm run check-chrome`。
4. 执行 `npm run feishu-test`。
5. 执行 `npm run run-task -- 惠州销售`。

`run-task` 会先自动 dry-run 校验；校验通过后直接进入 auto-greet，不需要人工二次确认。它会复用 dry-run 的规则和页面校验结果，并按相邻两次点击 3-5 秒随机间隔控制节奏；寻找、滚动、评分耗时会抵扣等待时间。合格候选人会批量交给同一个 AppleScript 会话处理，点击后轮询校验，滚动后也会等候选人变化后尽快继续。

## 重要限制

当前默认不自动切岗位、不自动打开筛选；只做页面一致性检查、候选人评分、打招呼和飞书回写。不做消息和简历闭环。

## 安全说明

不要提交真实 `config.private.json` 或 `config.env`。仓库只保留 `config.private.example.json` 和 `config.env.template`。
