#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const repository = args.get("--repo");
if (!repository) {
  throw new Error("missing repository; pass --repo <repository-root>");
}

const dashboardPath = path.join(path.resolve(repository), "TASKS.html");
const dashboard = readFileSync(dashboardPath, "utf8");
const positions = [
  ["待确认", dashboard.indexOf('class="card confirm"')],
  ["进行中", dashboard.indexOf('class="card active"')],
];

const missing = positions.filter(([, position]) => position < 0).map(([label]) => label);
if (missing.length) {
  throw new Error(`dashboard is missing summary cards: ${missing.join(", ")}`);
}

if (!(positions[0][1] < positions[1][1])) {
  throw new Error("dashboard summary cards must begin with 待确认 -> 进行中");
}

const requiredPatterns = [
  ['responsive summary cards', 'grid-template-columns:repeat(auto-fit,minmax(128px,1fr))'],
  ['compact horizontal filters', '.filters { display:flex;'],
  ['column chooser', 'id="column-picker"'],
  ['column toggle controls', 'data-column-toggle'],
  ['column visibility behavior', 'function applyColumnVisibility()'],
  ['local column preference', 'visibleColumns:[...visibleColumns]'],
];

const missingPatterns = requiredPatterns
  .filter(([, pattern]) => !dashboard.includes(pattern))
  .map(([label]) => label);
if (missingPatterns.length) {
  throw new Error(`dashboard is missing presentation contracts: ${missingPatterns.join(", ")}`);
}

if (dashboard.includes('id="posture-help"')) {
  throw new Error("dashboard must not render the redundant task-posture explanation row");
}

console.log(`OK: responsive cards, compact filters, local column preferences, and summary order validated (${dashboardPath})`);
