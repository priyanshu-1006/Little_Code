import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as vscode from 'vscode';
import { CommandReviewHost } from '../../src/extension/command-review';
import { WorkspaceService } from '../../src/little/tools/workspace-service';
import type { CommandResult, RuntimeEvent } from '../../src/little/shared/contracts';

/** Runs only through normal activation of an isolated development extension in packaged Little Code. */
export async function run(): Promise<void> {
  const profile = process.env.LITTLE_COMMAND_HOST_SMOKE_PROFILE;
  assert.ok(profile && path.isAbsolute(profile), 'An isolated smoke profile must be supplied.');
  assert.match(path.basename(profile), /^command-host-\d+-\d+-[a-f0-9]{12}$/);
  const project = path.join(profile, 'fixture-project');
  const progressPath = path.join(profile, 'progress.json');
  const eventsPath = path.join(profile, 'events.jsonl');
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder?.uri.scheme === 'file', 'The real extension host must open the fixture folder.');
  assert.equal((await fs.realpath(folder.uri.fsPath)).toLowerCase(), (await fs.realpath(project)).toLowerCase());
  assert.equal(vscode.workspace.isTrusted, true, 'Only the generated fixture project is trusted for this test.');
  const assertions: Record<string, boolean> = {};
  const events: RuntimeEvent[] = [];
  let eventWrites = Promise.resolve();
  let host: CommandReviewHost | undefined;
  const progress = async (phase: string, details: Record<string, unknown> = {}): Promise<void> => {
    await fs.writeFile(progressPath, `${JSON.stringify({ phase, assertions, ...details, updatedAt: new Date().toISOString() }, null, 2)}\n`);
  };
  const waitFor = async <T>(read: () => T | undefined, label: string, timeoutMs = 6000): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = read();
      if (value !== undefined) return value;
      await delay(30);
    }
    throw new Error(`Timed out waiting for ${label}.`);
  };
  const exists = async (filename: string): Promise<boolean> => fs.access(path.join(project, filename)).then(() => true, () => false);
  const proposalFor = async (runId: string) => waitFor(() => events.find((event): event is Extract<RuntimeEvent, { type: 'command.proposed' }> => event.type === 'command.proposed' && event.runId === runId), `${runId} command proposal`);
  try {
    await progress('extension-host-ready', { hostPid: process.pid, vscodeVersion: vscode.version });
    host = new CommandReviewHost(event => {
      events.push(event);
      eventWrites = eventWrites.then(() => fs.appendFile(eventsPath, `${JSON.stringify(event)}\n`));
    });
    const tool = host.tools(new WorkspaceService(project))[0];
    assert.ok(tool && tool.name === 'run_command');
    const command = (script: string, purpose: string) => ({ program: 'node', args: [script], cwd: '.', purpose, timeoutMs: 5000 });

    // The host's Reject path never opens a modal or starts a child process.
    const rejectedRequest = tool.execute(command('marker.cjs', 'Isolated smoke rejection marker'), { signal: new AbortController().signal, runId: 'smoke-reject' }) as Promise<CommandResult>;
    const rejectedProposal = await proposalFor('smoke-reject');
    assert.equal(await exists('allowed-marker.txt'), false);
    await host.decide(rejectedProposal.commandId, 'reject');
    const rejected = await rejectedRequest;
    assertions.rejectNoSideEffect = rejected.status === 'rejected' && rejected.exitCode === null && !await exists('allowed-marker.txt');
    assertions.rejectNoCommandStarted = !events.some(event => event.type === 'command.started' && event.runId === 'smoke-reject');
    assert.equal(assertions.rejectNoSideEffect && assertions.rejectNoCommandStarted, true);
    await progress('rejection-verified');

    // Allow once opens the actual VS Code modal. The owned CDP driver clicks its Run command button.
    const allowedRequest = tool.execute(command('marker.cjs', 'Isolated smoke approval marker'), { signal: new AbortController().signal, runId: 'smoke-allow' }) as Promise<CommandResult>;
    const allowedProposal = await proposalFor('smoke-allow');
    const allowedDecision = host.decide(allowedProposal.commandId, 'allow');
    await progress('allow-modal', { commandId: allowedProposal.commandId, script: 'marker.cjs' });
    await allowedDecision;
    const allowed = await allowedRequest;
    assertions.nativeAllowRunsRealNode = allowed.status === 'exited' && allowed.exitCode === 0 && allowed.output.includes('LITTLE_COMMAND_HOST_OK') && await exists('allowed-marker.txt');
    assert.equal(await fs.readFile(path.join(project, 'allowed-marker.txt'), 'utf8'), 'LITTLE_COMMAND_HOST_OK');
    assert.equal(assertions.nativeAllowRunsRealNode, true);
    await assert.rejects(host.decide(allowedProposal.commandId, 'allow'));
    assertions.allowOnceCannotBeReplayed = true;
    await progress('native-approval-verified', { result: allowed });

    const pendingController = new AbortController();
    const cancelledRequest = tool.execute(command('pending-marker.cjs', 'Isolated smoke pending cancellation'), { signal: pendingController.signal, runId: 'smoke-pending-cancel' }) as Promise<CommandResult>;
    await proposalFor('smoke-pending-cancel');
    pendingController.abort();
    const cancelled = await cancelledRequest;
    assertions.pendingCancellationNoExecution = cancelled.status === 'cancelled' && !await exists('pending-marker.txt') && !host.busy &&
      !events.some(event => event.type === 'command.started' && event.runId === 'smoke-pending-cancel');
    assert.equal(assertions.pendingCancellationNoExecution, true);
    await progress('pending-cancellation-verified');

    const runningRequest = tool.execute(command('late-marker.cjs', 'Isolated smoke running command disposal'), { signal: new AbortController().signal, runId: 'smoke-running-dispose' }) as Promise<CommandResult>;
    const runningProposal = await proposalFor('smoke-running-dispose');
    const runningDecision = host.decide(runningProposal.commandId, 'allow');
    await progress('dispose-modal', { commandId: runningProposal.commandId, script: 'late-marker.cjs' });
    await waitFor(() => events.find(event => event.type === 'command.started' && event.runId === 'smoke-running-dispose'), 'native approval and real command start', 12000);
    const startedDeadline = Date.now() + 5000;
    while (!await exists('running-marker.txt') && Date.now() < startedDeadline) await delay(30);
    assert.equal(await exists('running-marker.txt'), true, 'The real Node child must start before disposal.');
    assert.equal(await exists('late-marker.txt'), false, 'Disposal must precede the delayed side effect.');
    host.dispose();
    const disposed = await runningRequest;
    await runningDecision;
    assertions.executingDisposalCancelled = disposed.status === 'cancelled' && disposed.exitCode === null && !host.busy;
    assert.equal(assertions.executingDisposalCancelled, true);
    await delay(2100);
    assertions.disposalPreventsLateWrite = !await exists('late-marker.txt');
    assert.equal(assertions.disposalPreventsLateWrite, true);
    await assert.rejects(tool.execute(command('pending-marker.cjs', 'Closed host must not launch'), { signal: new AbortController().signal, runId: 'smoke-closed-host' }));
    assertions.closedHostRejectsNewCommands = !await exists('pending-marker.txt');
    assert.equal(assertions.closedHostRejectsNewCommands, true);
    await eventWrites;
    await progress('complete', { success: true, results: { rejected, allowed, cancelled, disposed }, hostPid: process.pid });
  } catch (error) {
    host?.dispose();
    await eventWrites.catch(() => undefined);
    await progress('failed', { success: false, error: error instanceof Error ? error.message : 'Native command host smoke failed.' });
    throw error;
  } finally {
    host?.dispose();
  }
}
