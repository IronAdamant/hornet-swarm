import { deleteAfterDelivery, HornetError, loadClientJob } from '@hornet-swarm/controller';
import type { Command } from 'commander';

/** Registers `hornet-swarm delete-after-delivery --job <file>`. */
export function registerDeleteAfterDelivery(program: Command): void {
  program
    .command('delete-after-delivery')
    .description("Delete one job's saved runs, page bodies, and evidence after the report is delivered")
    .requiredOption('--job <file>', 'job file')
    .option('--json', 'print machine-readable JSON')
    .action((opts: { job: string; json?: boolean }) => {
      try {
        const loaded = loadClientJob(opts.job);
        const result = deleteAfterDelivery(loaded.job.id);
        if (opts.json) process.stdout.write(`${JSON.stringify({ ok: true, job_id: loaded.job.id, ...result })}\n`);
        else process.stdout.write(result.removed.length === 0 ? 'No stored runs for that job.\n' : `Removed ${result.removed.join(', ')}.\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = error instanceof HornetError ? error.exitCode : 4;
        if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
        else process.stderr.write(`${message}\n`);
        process.exit(code);
      }
    });
}
