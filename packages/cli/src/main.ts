#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { HornetError, acceptBaseline, cleanupRetention, credentialStatus, defaultProjectFromHome, engageKill, envReset, envStatus, envUp, exportEvidence, measureResources, releaseKill, reliabilityMarkdown, reliabilityReport, requestCredentials, runDoctor, runSuite, startCredentialPage, stopRunners, storeOwnerLogin, swarmSnapshot } from '@hornet-swarm/controller';
import { Command } from 'commander';

const program = new Command();
program.name('hornet-swarm').description('Local authorised QA harness').version('0.1.0');

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
            report.power.summary,
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
  .option('--hard', 'rebuild the runner and proxy images and the project network')
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

program
  .command('suite')
  .option('--project <id>', 'project id')
  .option('--journey <file...>', 'journey files')
  .option('--gate <mode>', 'all or per_user')
  .option('--confirm-production', 'allow a production-looking target')
  .option('--chaos <profile>', 'chaos profile')
  .option('--seed <seed>', 'chaos seed')
  .option('--user <label...>', 'labels to run')
  .option('--agent-id <id>', 'refused unless it is this process')
  .option('--json', 'print machine-readable JSON')
  .action(async (opts: SuiteFlags) => {
    await runCommand(opts, {
      journeyFiles: opts.journey,
      ...(opts.user ? { users: opts.user } : {}),
      ...(opts.gate === 'all' || opts.gate === 'per_user' ? { gate: opts.gate } : {}),
      confirmProduction: Boolean(opts.confirmProduction),
      ...(opts.chaos ? { chaos: { profile: opts.chaos, seed: opts.seed ?? 'seed' } } : {}),
    });
  });

program
  .command('sign-in')
  .description('Run the sign-in check for one agent')
  .option('--project <id>', 'project id')
  .option('--user <label...>', 'labels to sign in')
  .option('--agent-id <id>', 'refused unless it is this process')
  .option('--json', 'print machine-readable JSON')
  .action(async (opts: SuiteFlags) => {
    await runCommand(opts, { phase1Only: true, ...(opts.user ? { users: opts.user } : {}) });
  });

program
  .command('journey')
  .description('Run one journey for one agent')
  .argument('<file>', 'journey file or id')
  .option('--project <id>', 'project id')
  .option('--user <label...>', 'labels to run')
  .option('--agent-id <id>', 'refused unless it is this process')
  .option('--json', 'print machine-readable JSON')
  .action(async (file: string, opts: SuiteFlags) => {
    await runCommand(opts, { journeyFiles: [file], includeRegressions: false, ...(opts.user ? { users: opts.user } : {}) });
  });

program
  .command('kill')
  .option('--release', 'allow new runs')
  .option('--project <id>', 'project whose runners to stop')
  .option('--json', 'print machine-readable JSON')
  .action(async (opts: { release?: boolean; project?: string; json?: boolean }) => {
    try {
      if (opts.release) {
        releaseKill();
        if (opts.json) writeJson({ ok: true, released: true });
        else process.stdout.write('Kill switch released.\n');
        return;
      }
      engageKill();
      await stopRunners(opts.project ?? defaultProjectFromHome());
      if (opts.json) writeJson({ ok: true, killed: true });
      else process.stdout.write('Kill switch is on. Runners were stopped.\n');
    } catch (error) {
      fail(opts.json, messageOf(error), 4);
    }
  });

program
  .command('request-credentials')
  .requiredOption('--project <id>', 'project id')
  .requiredOption('--label <label>', 'qa-user label')
  .requiredOption('--reason <text>', 'why the login is needed')
  .option('--json', 'print machine-readable JSON')
  .action(async (opts: { project: string; label: string; reason: string; json?: boolean }) => {
    try {
      const result = await requestCredentials({ project: opts.project, label: opts.label, reason: opts.reason });
      if (opts.json) writeJson(result);
      else process.stdout.write('waiting\n');
    } catch (error) {
      const code = error instanceof HornetError ? error.exitCode : 3;
      fail(opts.json, messageOf(error), code);
    }
  });

program
  .command('credential-status')
  .requiredOption('--id <id>', 'request id')
  .option('--json', 'print machine-readable JSON')
  .action((opts: { id: string; json?: boolean }) => {
    const result = credentialStatus(opts.id);
    if (opts.json) writeJson(result);
    else process.stdout.write(`${result.status ?? 'waiting'}\n`);
  });

const creds = program.command('creds').description('Owner-only login entry');
creds
  .command('serve')
  .option('--port <n>', 'loopback port', process.env.AEGIS_CREDENTIAL_PORT ?? '7781')
  .action(async (opts: { port?: string }) => {
    const port = Number(opts.port ?? 7781);
    await startCredentialPage(undefined, port);
    await new Promise(() => undefined);
  });
creds
  .command('add')
  .argument('<project>', 'project id')
  .argument('<label>', 'qa-user label')
  .option('--json', 'print machine-readable JSON')
  .action(async (project: string, label: string, opts: { json?: boolean }) => {
    try {
      // A password is kept exactly as typed, including leading or trailing spaces. Only the username and TOTP secret are trimmed.
      const lines = (await readHidden()).split(/\r?\n/);
      const username = lines[0]?.trim();
      const password = lines[1];
      const totp = lines[2]?.trim() || undefined;
      if (!username || !password) fail(opts.json, 'Type the username, then the password.', 3);
      const stored = storeOwnerLogin(project, label, username, password, totp);
      if (opts.json) writeJson(stored);
      else process.stdout.write(`Stored a login for ${label}.\n`);
    } catch (error) {
      fail(opts.json, messageOf(error), 3);
    }
  });

program
  .command('swarm')
  .description('Show the website and personalities once the owner has pressed Ready')
  .option('--project <id>', 'project id')
  .option('--json', 'print machine-readable JSON')
  .action(async (opts: { project?: string; json?: boolean }) => {
    const project = opts.project ?? defaultProjectFromHome();
    const view = await swarmSnapshot(project);
    if (opts.json) writeJson(view);
    else if (!view.ready) process.stdout.write('Not ready. Open http://127.0.0.1:7781/setup and press Ready.\n');
    else process.stdout.write(`${view.website}\n${view.agents.map((agent) => `${agent.label}: ${agent.personality}`).join('\n')}\n`);
  });

program
  .command('stats')
  .description('Show how reliable the site has been across recent runs')
  .option('--project <id>', 'project id')
  .option('--last <n>', 'how many recent runs to include', '20')
  .option('--json', 'print machine-readable JSON')
  .action((opts: { project?: string; last: string; json?: boolean }) => {
    const last = Number(opts.last);
    if (!Number.isInteger(last) || last < 1 || last > 500) fail(opts.json, 'last must be an integer from 1 to 500', 3);
    try {
      const report = reliabilityReport(opts.project ?? defaultProjectFromHome(), last);
      if (opts.json) writeJson(report);
      else process.stdout.write(reliabilityMarkdown(report));
    } catch (error) {
      fail(opts.json, messageOf(error), 3);
    }
  });

program
  .command('export-evidence')
  .argument('<runId>', 'run id')
  .requiredOption('--project <id>', 'project id')
  .requiredOption('--out <file>', 'zip path')
  .option('--json', 'print machine-readable JSON')
  .action(async (runId: string, opts: { project: string; out: string; json?: boolean }) => {
    try {
      const result = await exportEvidence(opts.project, runId, opts.out);
      if (opts.json) writeJson(result);
      else process.stdout.write(`${result.path}\n`);
    } catch (error) {
      fail(opts.json, messageOf(error), 1);
    }
  });

program
  .command('accept-baseline')
  .argument('<runId>', 'run id')
  .requiredOption('--project <id>', 'project id')
  .option('--json', 'print machine-readable JSON')
  .action((runId: string, opts: { project: string; json?: boolean }) => {
    try {
      const result = acceptBaseline(opts.project, runId);
      if (opts.json) writeJson(result);
      else process.stdout.write('Baseline saved.\n');
    } catch (error) {
      fail(opts.json, messageOf(error), 3);
    }
  });

program
  .command('cleanup')
  .option('--days <n>', 'delete runs older than this many days')
  .option('--json', 'print machine-readable JSON')
  .action((opts: { days?: string; json?: boolean }) => {
    const days = opts.days === undefined ? undefined : Number(opts.days);
    const removed = cleanupRetention(undefined, days);
    if (opts.json) writeJson({ ok: true, removed });
    else process.stdout.write(`${removed.length} old runs removed.\n`);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  fail(false, messageOf(error), 4);
});

function readHidden(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      const chunks: Buffer[] = [];
      process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
      process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      process.stdin.on('error', reject);
      return;
    }
    const ask = (prompt: string) =>
      new Promise<string>((done) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        const writer = rl as unknown as { _writeToOutput: (text: string) => void };
        const original = writer._writeToOutput.bind(rl);
        process.stdout.write(prompt);
        writer._writeToOutput = (text: string) => {
          if (text.includes('\n')) original(text);
        };
        rl.once('line', (line) => {
          rl.close();
          done(line);
        });
      });
    void (async () => {
      const username = await ask('Username: ');
      const password = await ask('Password: ');
      const totp = await ask('TOTP secret (blank to skip): ');
      resolve(`${username}\n${password}\n${totp}\n`);
    })().catch(reject);
  });
}

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

type SuiteFlags = {
  project?: string;
  journey?: string[];
  user?: string[];
  gate?: string;
  confirmProduction?: boolean;
  chaos?: string;
  seed?: string;
  agentId?: string;
  json?: boolean;
};

async function runCommand(
  opts: SuiteFlags,
  extra: {
    project?: string;
    journeyFiles?: string[];
    gate?: 'all' | 'per_user';
    confirmProduction?: boolean;
    chaos?: { profile: string; seed: string };
    phase1Only?: boolean;
    users?: string[];
    includeRegressions?: boolean;
  },
): Promise<void> {
  const ownId = `cli-${process.pid}`;
  if (opts.agentId && opts.agentId !== ownId) {
    fail(opts.json, 'That agent id belongs to another process.', 3);
  }
  try {
    const result = await runSuite({
      ...extra,
      project: opts.project ?? extra.project ?? defaultProjectFromHome(),
      agentId: ownId,
    });
    if (opts.json) writeJson(result);
    else {
      process.stdout.write('The parent must validate this run.\n');
      process.stdout.write(`${result.run_id}\n`);
      process.stdout.write(`${result.parent.packet_path}\n`);
      process.stdout.write(`${result.status}\n`);
    }
    const status = result.status;
    process.exit(status === 'passed' ? 0 : status === 'blocked' || status === 'rate_limited' ? 2 : status === 'error' ? 4 : 1);
  } catch (error) {
    const code = error instanceof HornetError ? error.exitCode : 4;
    if (opts.json) {
      writeJson({ ok: false, error: messageOf(error), agent_id: ownId });
      process.exit(code);
    }
    fail(false, messageOf(error), code);
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
