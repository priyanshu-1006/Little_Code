import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from './desktop-paths.mjs';

const cases = ['notebook', 'docx', 'pdf', 'notebook-edit', 'delete-slide'];
const checks = [];
for (const name of cases) {
  const file = `groq-file-${name}-live.json`;
  const report = JSON.parse(await readFile(path.join(projectRoot, 'desktop/logs', file), 'utf8'));
  const result = report.probes?.[0];
  assert.equal(report.configured, true);
  assert.equal(report.noUserProjectContent, true);
  assert.equal(report.credentialMechanism, 'native SecretStorage in extension host');
  assert.equal(report.closedOwnedWindow, true);
  assert.equal(result?.name, `runtime-file-${name}`);
  assert.equal(result.passed, true);
  assert.equal(result.completed, true);
  assert.equal(result.failure, undefined);
  assert.ok(result.requests.length >= 2);
  assert.ok(result.requests.every(request => request.status === 200 && request.stream === true &&
    request.structured === false && request.parallelToolCalls === false &&
    Number.isInteger(request.estimatedTokens) && request.estimatedTokens <= 5500));
  const reader = name === 'delete-slide' ? 'inspect_file' : name.startsWith('notebook') ? 'read_notebook' : 'read_document';
  assert.ok(result.toolCompletions.includes(reader));
  if (name === 'notebook-edit' || name === 'delete-slide') {
    assert.ok(result.toolCompletions.includes(name === 'delete-slide' ? 'propose_file_edits' : 'propose_notebook_edits'));
    assert.equal(result.rejectedReviews.length, 1);
    assert.equal(result.rejectedReviews[0].status, 'rejected');
    assert.equal(result.fixtureUnchanged, true);
  } else assert.equal(result.answerHasFixturePhrase, true);
  checks.push({ case: result.name, evidence: file, probeId: report.probeId,
    completed: true, passed: true, closedOwnedWindow: true,
    tools: result.toolCompletions, httpStatuses: result.requests.map(request => request.status),
    estimatedRequestTokens: result.requests.map(request => request.estimatedTokens),
    ...(name === 'notebook-edit' || name === 'delete-slide' ? { review: 'rejected', originalBytesUnchanged: true } : { citedFixturePhrase: true }),
  });
}
const summary = { success: true, verifiedAt: new Date().toISOString(),
  model: 'openai/gpt-oss-120b', credentialMechanism: 'native SecretStorage in extension host',
  scope: 'Owned-fixture native-provider/runtime reads, a notebook edit and a whole-file slide deletion proposal, both rejected by the test host. No user project content or accepted mutation/command was sent or executed.',
  checks,
  observations: ['An earlier PDF read succeeded but its answer used typographic hyphens; the final probe records exact source evidence and copied ASCII text.',
    'An earlier proposal probe omitted its private checkpoint directory; the corrected fixture created it before staging.'],
  limits: 'These cases establish the recorded live Groq tool flows. Accepted changes are separately tested with native UI fixtures; real Ollama inference, arbitrary document layouts and complete PRD acceptance are separate checks.',
};
await writeFile(path.join(projectRoot, 'desktop/logs/groq-file-live-acceptance.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ success: true, cases: checks.length, requests: checks.reduce((sum, check) => sum + check.httpStatuses.length, 0),
  maxEstimatedRequestTokens: Math.max(...checks.flatMap(check => check.estimatedRequestTokens)) }));
