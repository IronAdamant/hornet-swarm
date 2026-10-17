import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writePrivateFile } from '@hornet-swarm/core';
import { aegisHome } from './home.js';

export type AiUsage = {
  model_calls: number;
  /** Sum of cost_usd on recorded calls. A run with no calls is 0. Nothing here is a guessed price. */
  cost_usd: number;
  unit: 'USD';
};

/**
 * Counts model calls recorded under a run. This harness does not call a model itself.
 * A call is one line of ai-calls.jsonl. The cost is only what that line already records.
 */
export function measureAiUsage(runDir: string): AiUsage {
  let modelCalls = 0;
  let costUsd = 0;
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      let info;
      try {
        info = lstatSync(path);
      } catch {
        continue;
      }
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        walk(path);
        continue;
      }
      if (name !== 'ai-calls.jsonl') continue;
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        modelCalls += 1;
        try {
          const cost = (JSON.parse(line) as { cost_usd?: unknown }).cost_usd;
          if (typeof cost === 'number' && Number.isFinite(cost)) costUsd += cost;
        } catch {
          // A line that is not JSON still counts as a call, and adds nothing to the cost.
        }
      }
    }
  };
  if (existsSync(runDir)) walk(runDir);
  return { model_calls: modelCalls, cost_usd: costUsd, unit: 'USD' };
}

/** Writes ai-usage.json beside a finished run. A failure here does not change the run result. */
export function recordAiUsage(runId: string, home = aegisHome()): void {
  try {
    if (!/^run_[A-Za-z0-9_-]+$/.test(runId)) return;
    const runDir = join(home, 'runs', runId);
    if (!existsSync(runDir)) return;
    const usage = measureAiUsage(runDir);
    const note = usage.model_calls === 0 ? 'This run made no model calls. The cost is 0 USD.' : 'Cost is the sum of cost_usd recorded on each model call.';
    writePrivateFile(join(runDir, 'ai-usage.json'), `${JSON.stringify({ ...usage, note }, null, 2)}\n`);
  } catch {
    // The usage log is not the run result.
  }
}
