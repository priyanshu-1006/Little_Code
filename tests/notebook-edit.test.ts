import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import test, { type TestContext } from 'node:test';
import { buildNotebookEdit, createNotebookEditTools } from '../src/little/tools/notebook-edit-tools';
import { EditProposalService, type EditProposal } from '../src/little/tools/edit-proposals';
import { WorkspaceService } from '../src/little/tools/workspace-service';
import { LittleError } from '../src/little/shared/errors';

const signal = () => new AbortController().signal;
const json = () => JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: { custom: 'keep notebook metadata' }, cells: [
  { cell_type: 'markdown', source: ['# Lesson\n', 'Existing explanation'], metadata: { tags: ['intro'] }, attachments: { 'a.png': { 'image/png': 'PRIVATE_ATTACHMENT' } } },
  { cell_type: 'code', source: ['value = 1\n'], metadata: { tags: ['example'] }, id: 'original-id', execution_count: 5, outputs: [{ output_type: 'stream', name: 'stdout', text: 'PRIVATE_CHANGED_OUTPUT' }] },
  { cell_type: 'code', source: 'result = value + 2', metadata: {}, execution_count: 6, outputs: [{ output_type: 'stream', name: 'stdout', text: 'PRIVATE_UNCHANGED_OUTPUT' }] },
] });
async function fixture(t: TestContext) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'little-notebook-edit-'));
  t.after(async () => { assert.equal(path.dirname(base), path.resolve(os.tmpdir())); assert.ok(path.basename(base).startsWith('little-notebook-edit-')); await fs.rm(base, { recursive: true, force: true }); });
  const root = path.join(base, 'workspace'), storage = path.join(base, 'private');
  await fs.mkdir(root); await fs.mkdir(storage);
  const workspace = new WorkspaceService(root), service = new EditProposalService(workspace, storage);
  return { root, storage, workspace, service };
}
const edit = { path: 'lesson.ipynb', action: 'edit' as const, edits: [{ operation: 'replace' as const, cell: 2, expectedSource: 'value = 1\n', source: 'value = 10\n' }] };

test('cell replacement preserves metadata, attachments and unrelated outputs, but clears changed code execution state', () => {
  const built = buildNotebookEdit(json(), edit);
  const before = JSON.parse(json()), after = JSON.parse(built.content.toString('utf8'));
  assert.deepEqual(after.metadata, before.metadata);
  assert.deepEqual(after.cells[0], before.cells[0]);
  assert.deepEqual(after.cells[2], before.cells[2]);
  assert.equal(after.cells[1].source, 'value = 10\n');
  assert.equal(after.cells[1].id, 'original-id');
  assert.deepEqual(after.cells[1].metadata, before.cells[1].metadata);
  assert.deepEqual(after.cells[1].outputs, []);
  assert.equal(after.cells[1].execution_count, null);
  assert.doesNotMatch(JSON.stringify(built.preview), /PRIVATE_/);
  assert.match(built.preview.proposed, /saved output cleared/);
});

test('sequential notebook insert and delete produce valid code and markdown cells with source guards', () => {
  const built = buildNotebookEdit(json(), { path: 'lesson.ipynb', action: 'edit', edits: [
    { operation: 'insert', cell: 2, cellType: 'markdown', source: 'New explanation' },
    { operation: 'delete', cell: 3, expectedSource: 'value = 1\n' },
  ] });
  const cells = JSON.parse(built.content.toString('utf8')).cells;
  assert.equal(cells.length, 3);
  assert.equal(cells[1].cell_type, 'markdown');
  assert.equal(cells[1].source, 'New explanation');
  assert.equal(cells[2].source, 'result = value + 2');
  assert.doesNotMatch(built.preview.original ?? '', /PRIVATE_/);
  assert.throws(() => buildNotebookEdit(json(), { ...edit, edits: [{ ...edit.edits[0]!, expectedSource: 'stale' }] }), /does not match exactly/);
});

test('new notebooks use sequential insert positions and valid execution fields without selecting an installed kernel', () => {
  const built = buildNotebookEdit(undefined, { path: 'new.ipynb', action: 'create', edits: [
    { operation: 'insert', cell: 1, cellType: 'markdown', source: '# Introduction' },
    { operation: 'insert', cell: 2, cellType: 'code', source: 'print("hello")' },
  ] });
  const notebook = JSON.parse(built.content.toString('utf8'));
  assert.equal(notebook.nbformat, 4); assert.equal(notebook.nbformat_minor, 5);
  assert.deepEqual(notebook.metadata, {}); assert.deepEqual(notebook.cells[1].outputs, []);
  assert.equal(notebook.cells[1].execution_count, null); assert.equal(built.preview.original, null);
  assert.throws(() => buildNotebookEdit(undefined, { path: 'new.ipynb', action: 'create', edits: [{ operation: 'insert', cell: 2, cellType: 'code', source: 'x = 1' }] }), /Insert at/);
});

test('notebook tool rejects malformed structure, unsupported actions and oversized arguments before review', async t => {
  const f = await fixture(t);
  const tool = createNotebookEditTools(f.workspace, f.service, async () => { assert.fail('must not review'); }, () => {})[0]!;
  for (const input of [{ ...edit, path: 'x.ts' }, { ...edit, edits: [{ operation: 'run', cell: 1 }] }, { ...edit, edits: [{ operation: 'insert', cell: 1, cellType: 'code', source: 'x'.repeat(32_001) }] }]) assert.throws(() => tool.validate(input), LittleError);
  assert.throws(() => buildNotebookEdit('{"nbformat":4}', edit), LittleError);
  assert.throws(() => buildNotebookEdit(json(), { ...edit, edits: [{ operation: 'replace', cell: 1, expectedSource: '# Lesson\nExisting explanation', source: '# Lesson\nExisting explanation' }] }), /must change/);
});

test('review rejection and dirty notebook checks preserve exact bytes', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'lesson.ipynb'), json());
  let reviewed = 0;
  const tool = createNotebookEditTools(f.workspace, f.service, async () => { reviewed++; return { status: 'rejected' }; }, () => {})[0]!;
  const result = await tool.execute(edit, { signal: signal(), runId: 'test-notebook' }) as { status: string };
  assert.equal(result.status, 'rejected'); assert.equal(reviewed, 1);
  assert.equal(await fs.readFile(path.join(f.root, 'lesson.ipynb'), 'utf8'), json());
  assert.deepEqual(await fs.readdir(f.storage), []);
  const dirty = createNotebookEditTools(f.workspace, f.service, async () => { assert.fail(); }, () => { throw new LittleError('PERMISSION_DENIED', 'dirty'); })[0]!;
  await assert.rejects(dirty.execute(edit, { signal: signal() }), /dirty/);
});

test('accepted notebook cell edits have reversible exact-byte checkpoints, including original BOM and output bytes', async t => {
  const f = await fixture(t), original = Buffer.from('\uFEFF' + json());
  await fs.writeFile(path.join(f.root, 'lesson.ipynb'), original);
  let checkpoint = '';
  const tool = createNotebookEditTools(f.workspace, f.service, async proposal => {
    assert.ok(f.service.preview(proposal.id)[0]!.proposed.includes('value = 10'));
    const result = await f.service.apply(f.service.accept(proposal.id)); checkpoint = result.checkpointId; return result;
  }, () => {})[0]!;
  const result = await tool.execute(edit, { signal: signal(), runId: 'test-notebook' }) as { status: string; cellsExecuted: boolean };
  assert.equal(result.status, 'applied'); assert.equal(result.cellsExecuted, false);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, 'lesson.ipynb'), 'utf8')).cells[1].source, 'value = 10\n');
  const reopened = new EditProposalService(f.workspace, f.storage);
  assert.deepEqual((await reopened.rollback(checkpoint)).conflicts, []);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'lesson.ipynb')), original);
});

test('creating a notebook goes through review and checkpoint restoration removes only the newly created file', async t => {
  const f = await fixture(t); let checkpoint = '';
  const tool = createNotebookEditTools(f.workspace, f.service, async proposal => { const result = await f.service.apply(f.service.accept(proposal.id)); checkpoint = result.checkpointId; return result; }, () => {})[0]!;
  const result = await tool.execute({ path: 'new.ipynb', action: 'create', edits: [{ operation: 'insert', cell: 1, cellType: 'code', source: 'x = 1' }] }, { signal: signal() }) as { status: string };
  assert.equal(result.status, 'applied');
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, 'new.ipynb'), 'utf8')).cells[0].source, 'x = 1');
  assert.deepEqual((await f.service.rollback(checkpoint)).conflicts, []);
  await assert.rejects(fs.stat(path.join(f.root, 'new.ipynb')), { code: 'ENOENT' });
});

test('changing a notebook after source extraction cannot apply a stale generated replacement', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'lesson.ipynb'), json());
  let staged: EditProposal | undefined;
  const tool = createNotebookEditTools(f.workspace, f.service, async proposal => {
    staged = proposal;
    await fs.writeFile(path.join(f.root, 'lesson.ipynb'), json() + '\n');
    return f.service.apply(f.service.accept(proposal.id));
  }, () => {})[0]!;
  await assert.rejects(tool.execute(edit, { signal: signal() }), /original changed after staging/);
  assert.ok(staged);
  assert.equal(await fs.readFile(path.join(f.root, 'lesson.ipynb'), 'utf8'), json() + '\n');
});

test('large notebook cells can receive a unique inspected literal patch with normalized source lines', () => {
  const notebook = JSON.parse(json());
  notebook.cells[1].source = 'header\r\n' + 'unchanged = 1\r\n'.repeat(200) + 'target = 2\r\n';
  const built = buildNotebookEdit(JSON.stringify(notebook), { path: 'lesson.ipynb', action: 'edit', edits: [
    { operation: 'patch', cell: 2, search: 'target = 2\n', replacement: 'target = 3\n' },
  ] });
  assert.match(JSON.parse(built.content.toString('utf8')).cells[1].source, /target = 3\n$/);
  assert.throws(() => buildNotebookEdit(JSON.stringify(notebook), { path: 'lesson.ipynb', action: 'edit', edits: [
    { operation: 'patch', cell: 2, search: 'unchanged = 1', replacement: 'changed = 2' },
  ] }), /match exactly once/);
});
