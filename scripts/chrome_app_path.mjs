import fs from "node:fs";

const CANDIDATES = [
  process.env.CHROME_APP,
  "/Users/dailinlee/Desktop/Google Chrome.app",
  `${process.env.HOME || ""}/Desktop/Google Chrome.app`,
  "/Applications/Google Chrome.app",
  `${process.env.HOME || ""}/Applications/Google Chrome.app`,
].filter(Boolean);

export function chromeAppPath() {
  for (const candidate of CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "/Applications/Google Chrome.app";
}

