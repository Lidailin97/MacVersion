import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function resolveRunDir() {
  const preferred = process.env.BOSS_RUN_DIR || path.join(os.homedir(), ".boss-feishu-greeter-260505");
  try {
    fs.mkdirSync(preferred, { recursive: true });
    return preferred;
  } catch {
    const fallback = path.join(process.cwd(), ".run");
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

export function paths() {
  const dir = resolveRunDir();
  return {
    dir,
    stopFile: path.join(dir, ".stop"),
    stateFile: path.join(dir, "state.json"),
    pidFile: path.join(dir, "pid"),
  };
}

export function runId(city = "", jobType = "") {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const safeCity = String(city || "未知城市").replace(/\s+/g, "");
  const safeJobType = String(jobType || "未知岗位").replace(/\s+/g, "");
  return `greet_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}_${safeCity}_${safeJobType}`;
}

export function shouldStop() {
  return fs.existsSync(paths().stopFile);
}

export function writePid() {
  fs.writeFileSync(paths().pidFile, String(process.pid));
}

export function clearStop() {
  const { stopFile } = paths();
  if (fs.existsSync(stopFile)) fs.rmSync(stopFile, { force: true });
}

export function saveState(state) {
  fs.writeFileSync(paths().stateFile, JSON.stringify(state, null, 2));
}

export function touchStop() {
  fs.writeFileSync(paths().stopFile, new Date().toISOString());
}
