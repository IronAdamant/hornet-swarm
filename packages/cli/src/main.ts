#!/usr/bin/env node
import { runDoctor } from '@aegis/controller';
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
    if (!Number.isInteger(n) || n < 1 || n > 30) {
      fail(opts.json, 'estimate must be an integer from 1 to 30', 3);
    }
    try {
      const report = await runDoctor(n);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(report)}\n`);
      } else {
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
      fail(opts.json, error instanceof Error ? error.message : String(error), 4);
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(4);
});

function fail(json: boolean | undefined, message: string, code: number): never {
  if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  else process.stderr.write(`${message}\n`);
  process.exit(code);
}
