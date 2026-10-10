import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import test, { type TestContext } from 'node:test';
import { WorkspaceService, WORKSPACE_LIMITS } from '../src/little/tools/workspace-service';
import { LittleError } from '../src/little/shared/errors';
import { createReadOnlyTools } from '../src/little/tools/read-only-tools';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'little-binary-reader-'));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('little-binary-reader-')); await fs.rm(root, { recursive: true, force: true }); });
  return { root, workspace: new WorkspaceService(root) };
}
const code = (expected: string) => (error: unknown) => error instanceof LittleError && error.code === expected;

test('host binary reads preserve exact bytes while inspect_file returns only evidence metadata', async t => {
  const f = await fixture(t), bytes = Buffer.from([0, 1, 2, 250, 255]);
  await fs.writeFile(path.join(f.root, 'picture.png'), bytes);
  assert.deepEqual((await f.workspace.readBinaryFile('picture.png')).bytes, bytes);
  const info = await f.workspace.inspectFile('picture.png');
  assert.equal(info.bytes, bytes.length); assert.equal(info.contentIncluded, false);
  assert.equal(info.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal('content' in info, false);
  await assert.rejects(f.workspace.readFile('picture.png'), code('TOOL_FAILED'));
  const tool = createReadOnlyTools(f.workspace, { snapshot: () => ({ openFiles: [], diagnostics: [] }) }).find(tool => tool.name === 'inspect_file')!;
  assert.equal(tool.risk, 'SAFE');
  assert.deepEqual(await tool.execute({ path: 'picture.png' }, { signal: new AbortController().signal }), info);
});

test('complete binary reads enforce sensitive, traversal and freshly changed ignore policy', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'visible.pdf'), '%PDF-fixture');
  await fs.writeFile(path.join(f.root, '.env'), 'private');
  assert.equal((await f.workspace.readBinaryFile('visible.pdf')).totalBytes, 12);
  await fs.writeFile(path.join(f.root, '.littleignore'), 'visible.pdf\n');
  await assert.rejects(f.workspace.readBinaryFile('visible.pdf'), code('PERMISSION_DENIED'));
  await assert.rejects(f.workspace.inspectFile('.env'), code('PERMISSION_DENIED'));
  await assert.rejects(f.workspace.readBinaryFile('../outside.pdf'), code('WORKSPACE_BOUNDARY_VIOLATION'));
});

test('format readers get complete input or an explicit bounded/cancelled failure, never shortened binary', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'bounded.dat'), Buffer.alloc(1025, 1));
  await assert.rejects(f.workspace.readBinaryFile('bounded.dat', undefined, 1024), code('CONTEXT_LIMIT'));
  const complete = await f.workspace.readBinaryFile('bounded.dat', undefined, 1025);
  assert.equal(complete.bytes.length, 1025);
  await assert.rejects(f.workspace.readBinaryFile('bounded.dat', undefined, WORKSPACE_LIMITS.maxDocumentBytes + 1), code('TOOL_VALIDATION_FAILED'));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.workspace.readBinaryFile('bounded.dat', controller.signal), code('AGENT_CANCELLED'));
  await assert.rejects(f.workspace.inspectFile('bounded.dat', controller.signal), code('AGENT_CANCELLED'));
});
