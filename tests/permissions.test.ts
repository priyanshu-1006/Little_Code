import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyCommand, DEFAULT_COMMAND_RISK_RULES } from '../src/little/permissions/command-risk';
import { PermissionEngine } from '../src/little/permissions/permission-engine';
import type { AgentMode, ToolRisk } from '../src/little/shared/contracts';

test('Ask and Plan permit safe tools and deny every privileged risk', () => {
  const permissions = new PermissionEngine();
  for (const mode of ['ask', 'plan'] as const) {
    assert.equal(permissions.evaluate(mode, 'SAFE'), true);
    for (const risk of ['WORKSPACE_WRITE', 'EXECUTION', 'SENSITIVE', 'DANGEROUS'] as const) assert.equal(permissions.evaluate(mode, risk), false);
  }
  assert.equal(permissions.evaluate('unsupported' as AgentMode, 'SAFE'), false);
  assert.equal(permissions.evaluate('ask', 'UNKNOWN' as ToolRisk), false);
});

test('command classification keeps test execution separate from observation', () => {
  assert.equal(classifyCommand('git status --short'), 'SAFE');
  assert.equal(classifyCommand('git diff --stat'), 'SAFE');
  assert.equal(classifyCommand('npm test'), 'EXECUTION');
  assert.equal(classifyCommand('npm run build'), 'EXECUTION');
  assert.equal(classifyCommand('tsc --noEmit'), 'EXECUTION');
  assert.equal(classifyCommand('node unknown-script.js'), 'EXECUTION');
  assert.equal(classifyCommand('git diff --ext-diff'), 'EXECUTION');
});

test('Edit permits staged workspace proposals but denies execution and higher risks', () => {
  const permissions = new PermissionEngine();
  assert.equal(permissions.evaluate('edit', 'SAFE'), true);
  assert.equal(permissions.evaluate('edit', 'WORKSPACE_WRITE'), true);
  for (const risk of ['EXECUTION', 'SENSITIVE', 'DANGEROUS'] as const) assert.equal(permissions.evaluate('edit', risk), false);
});

test('Agent permits read, reviewed edits, and approved execution while higher risks remain denied', () => {
  const permissions = new PermissionEngine();
  for (const risk of ['SAFE', 'WORKSPACE_WRITE', 'EXECUTION'] as const) assert.equal(permissions.evaluate('agent', risk), true);
  for (const risk of ['SENSITIVE', 'DANGEROUS'] as const) assert.equal(permissions.evaluate('agent', risk), false);
  assert.equal(permissions.evaluate('agent', 'UNKNOWN' as ToolRisk), false);
});

test('package, network, credential, destructive, and composed commands escalate risk', () => {
  for (const command of ['npm install dependency', 'pnpm add dependency', 'npx unknown-package', 'git commit -m change', 'curl https://host', 'cat .env']) assert.equal(classifyCommand(command), 'SENSITIVE', command);
  for (const command of ['git push origin main', 'rm -rf .', 'Remove-Item src -Recurse', 'npm test && npm install bad', 'git status > output.txt', 'echo $(whoami)', 'cat ..\\outside\\secret.txt', 'node C:\\outside\\task.js', '']) assert.equal(classifyCommand(command), 'DANGEROUS', command);
});

test('custom risk rules can raise risk without lowering matched destructive rules', () => {
  const rules = [...DEFAULT_COMMAND_RISK_RULES, { id: 'project-script', risk: 'SENSITIVE' as const, matches: (command: string) => command === 'npm run database-refresh' }];
  assert.equal(classifyCommand('npm run database-refresh', rules), 'SENSITIVE');
  assert.equal(classifyCommand('git push', [...rules, { id: 'bad-override', risk: 'SAFE', matches: () => true }]), 'DANGEROUS');
});
