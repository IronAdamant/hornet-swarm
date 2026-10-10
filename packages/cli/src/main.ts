#!/usr/bin/env node
import { defaultProjectFromHome, envReset, envStatus, envUp, measureResources, runDoctor } from '@aegis/controller';
import { Command } from 'commander';

const program = new Command();
program.name('aegis').description('Local authorised QA harness').version('0.1.0');

program
  .command('doctor')
  .description('Check the container runtime and print resource figures')
  .option('--estimate <n>', 'resource figures for N runners', '10')
  .option('--json', 'print machine-readable JSON')
  .action(async (opts: { estimate: string; json?: boolean }) => {
    const n = Number(opts.estimate);
    if (!Number.isInteger(n) || n < 1 || n > 30) fail(opts.json, 'estimate must be an integer from 1 to 30', 3);
    try {
      const report = await runDoctor(n);
      if (opts.json) writeJson(report);
      else {
        process.stdout.write(
          [
            `Runtime: ${report.runtimeName} (${report.runtime})`,
            `Docker API: ${report.docker.apiVersion}`,
            `Server: ${report.docker.serverVersion} ${report.docker.os}/${report.docker.arch}`,
            `Engine OS: ${report.docker.operatingSystem}`,
            `CPUs: ${report.docker.cpus}`,
            `Engine memory: ${report.docker.memoryBytes} bytes`,
            '',
            report.estimate.summary,
            '',
          ].join('\n'),
        );
      }
    } catch (error) {
      fail(opts.json, messageOf(error), 4);
    }
  });

const env = program.command('env').description('Start, reset, and inspect runner containers');

env
  .command('up')
  .option('--project <id>', 'project id')
  .option('--count <n>', 'how many runners to start')
  .option('--json', 'print machine-readable JSON')
  .action(async (opts: { project?: string; count?: string; json?: boolean }) => {
    try {
      const status = await envUp({ project: opts.project ?? defaultProjectFromHome(), count: parseCount(opts.count) });
      if (opts.json) writeJson(status);
      else writeStatus(status);
      if (status.healthy !== status.expected) process.exit(4);
    } catch (error) {
      fail(opts.json, messageOf(error), 4);
    }
  });

env
  .command('reset')
  .option('--project <id>', 'project id')
  .option('--count <n>', 'how many runners to recreate')
  .option('--hard', 'also remove the project network')
  .option('--json', 'print machine-readable JSON')
  .action(async (opts: { project?: string; count?: string; hard?: boolean; json?: boolean }) => {
    try {
      const status = await envReset({
        project: opts.project ?? defaultProjectFromHome(),
        count: parseCount(opts.count),
        hard: Boolean(opts.hard),
      });
      if (opts.json) writeJson(status);
      else {
        process.stdout.write(`Reset finished in ${status.durationMs} ms\n`);
        writeStatus(status);
      }
      if (status.healthy !== status.expected) process.exit(4);
    } catch (error) {
      fail(opts.json, messageOf(error), 4);
    }
  });

env
  .command('status')
  .option('--project <id>', 'project id')
  .option('--json', 'print machine-readable JSON')
  .action(async (opts: { project?: string; json?: boolean }) => {
    try {
      const status = await envStatus(opts.project ?? defaultProjectFromHome());
      if (opts.json) writeJson(status);
      else writeStatus(status);
    } catch (error) {
      fail(opts.json, messageOf(error), 4);
    }
  });

env
  .command('measure')
  .option('--project <id>', 'project id')
  .option('--json', 'print machine-readable JSON')
  .action(async (opts: { project?: string; json?: boolean }) => {
    try {
      const table = await measureResources(opts.project ?? defaultProjectFromHome());
      if (opts.json) writeJson(table);
      else process.stdout.write(`${JSON.stringify(table, null, 2)}\n`);
    } catch (error) {
      fail(opts.json, messageOf(error), 4);
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  fail(false, messageOf(error), 4);
});

function parseCount(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 30) fail(false, 'count must be an integer from 1 to 30', 3);
  return count;
}

function writeStatus(status: { project: string; healthy: number; expected: number; runners: Array<{ label: string; health: string; state: string; port: number | null }> }): void {
  process.stdout.write(`${status.project}: ${status.healthy}/${status.expected} healthy\n`);
  for (const runner of status.runners) {
    process.stdout.write(`${runner.label}\t${runner.health}\t${runner.state}\t${runner.port ?? '-'}\n`);
  }
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(json: boolean | undefined, message: string, code: number): never {
  if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  else process.stderr.write(`${message}\n`);
  process.exit(code);
}
