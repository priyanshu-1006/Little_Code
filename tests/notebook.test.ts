import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { type TestContext } from 'node:test';
import { LittleError } from '../src/little/shared/errors';
import { extractNotebookSource, NOTEBOOK_LIMITS, notebookCellRange, readNotebookSource, type NotebookWorkspaceReader } from '../src/little/tools/notebook-source';
import { createNotebookTools } from '../src/little/tools/notebook-tools';
import { WorkspaceService } from '../src/little/tools/workspace-service';

const notebook = (cells: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells, ...extra });
const code = (source: unknown, extra: Record<string, unknown> = {}) => ({ cell_type: 'code', source, metadata: {}, outputs: [], execution_count: null, ...extra });
const markdown = (source: unknown, extra: Record<string, unknown> = {}) => ({ cell_type: 'markdown', source, metadata: {}, ...extra });
const isError = (code: string) => (error: unknown): boolean => error instanceof LittleError && error.code === code;
const signal = () => new AbortController().signal;

test('focused notebook source lines reach later large-cell evidence without leaking earlier source secrets', async t => {
  const lines = Array.from({ length: 240 }, (_, index) => `value_${index + 1} = ${index + 1}`);
  lines[5] = '-----BEGIN PRIVATE KEY-----'; lines[10] = 'PRIVATE_KEY_HIDDEN'; lines[15] = '-----END PRIVATE KEY-----';
  const source = extractNotebookSource(notebook([code(lines.join('\n'))]), 'large.ipynb', { startCell: 1, endCell: 1, startLine: 201, endLine: 220 });
  assert.equal(source.cells[0]!.startLine, 201); assert.equal(source.cells[0]!.endLine, 220);
  assert.match(source.content, /large\.ipynb#cell-1:source-201/);
  assert.match(source.content, /220\| value_220 = 220/);
  assert.doesNotMatch(source.content, /PRIVATE_KEY_HIDDEN|value_1 =/);
  assert.equal(source.truncated, true);
  assert.throws(() => extractNotebookSource(notebook([code(lines.join('\n')), code('x=1')]), 'large.ipynb', { startCell: 1, endCell: 2, startLine: 201 }), /select one notebook cell/);
  const reader: NotebookWorkspaceReader = { async readNotebookFile() { assert.fail('range validation must precede I/O'); } };
  const tool = createNotebookTools(reader)[0]!;
  assert.throws(() => tool.validate({ path: 'large.ipynb', startCell: 1, endCell: 2, startLine: 201 }), /Select one cell/);
  t.diagnostic('The read guard validates a focused cell range before touching the workspace.');
});

test('notebook source joins string arrays and cites original cells and source lines without outputs or metadata', () => {
  const json = notebook([
    markdown('# Course introduction\nBuild a model.', { attachments: { 'image.png': { 'image/png': 'PRIVATE_ATTACHMENT_IMAGE' } } }),
    code(['import pandas as pd\n', 'model = train(data)\n'], { execution_count: 137, outputs: [
      { output_type: 'display_data', data: { 'image/png': 'PRIVATE_OUTPUT_IMAGE', 'text/plain': 'PRIVATE_OUTPUT_TEXT' } },
    ], metadata: { custom: 'PRIVATE_CELL_METADATA' } }),
    { cell_type: 'raw', source: 'PRIVATE_RAW_SOURCE', metadata: {} },
    code(['joined', '_identifier = 1']),
  ], { metadata: { authors: [{ name: 'PRIVATE_AUTHOR' }], execution: 'PRIVATE_EXECUTION_METADATA' } });
  const source = extractNotebookSource(json, 'course/lesson.ipynb');
  assert.equal(source.totalCells, 4);
  assert.deepEqual(source.cells.map(cell => [cell.cell, cell.type, cell.totalLines]), [[1, 'markdown', 2], [2, 'code', 3], [4, 'code', 1]]);
  assert.match(source.content, /lesson\.ipynb#cell-2:source-1 \(code/);
  assert.match(source.content, /1\| import pandas as pd\n2\| model = train\(data\)/);
  assert.match(source.content, /1\| joined_identifier = 1/);
  assert.equal(source.outputsIncluded, false);
  assert.equal(source.metadataIncluded, false);
  assert.equal(source.omittedCellTypes, 1);
  assert.equal(source.omittedCells, 1);
  assert.equal(source.truncated, false);
  assert.equal(JSON.stringify(source).includes('PRIVATE_'), false);
  assert.doesNotMatch(source.content, /"cells"|execution_count|output_type/);
});

test('source secrets are redacted after JSON parsing and before selecting later cell ranges', () => {
  const key = 'gsk_abcdefghijklmnop012345';
  const json = notebook([
    code('-----BEGIN PRIVATE KEY-----\nPRIVATE_BLOCK_BEGIN'),
    code('PRIVATE_BLOCK_MIDDLE\n-----END PRIVATE KEY-----\n' + `API_KEY = "${key}"\n` + 'safe_value = 3'),
    markdown('Bearer abcdefghijklmnop\npassword = "PRIVATE_PASSWORD"'),
  ]);
  const source = extractNotebookSource(json, 'secrets-in-source.ipynb', { startCell: 2, endCell: 3 });
  assert.deepEqual(source.cells.map(cell => cell.cell), [2, 3]);
  assert.match(source.content, /1\| \[REDACTED\]/);
  assert.match(source.content, /4\| safe_value = 3/);
  assert.equal(JSON.stringify(source).includes('PRIVATE_'), false);
  assert.equal(JSON.stringify(source).includes(key), false);
  assert.match(source.content, /\[REDACTED\]/);
  assert.equal(source.startCell, 2);
  assert.equal(source.endCell, 3);
  assert.equal(source.truncated, true);
});

test('inline base64 images in markdown source are omitted while their source line positions remain intact', () => {
  const source = extractNotebookSource(notebook([markdown('Plot: ![chart](data:image/png;base64,MIMEIMAGEPAYLOAD\nSECONDIMAGEPAYLOAD)\nExplain this chart.')]), 'images.ipynb');
  assert.equal(source.cells[0]!.totalLines, 3);
  assert.match(source.content, /IMAGE DATA OMITTED/);
  assert.match(source.content, /3\| Explain this chart/);
  assert.doesNotMatch(source.content, /MIMEIMAGEPAYLOAD|SECONDIMAGEPAYLOAD|data:image/);
});

test('bounded ranges, source characters and source lines keep omissions explicit and original numbering intact', () => {
  const source = extractNotebookSource(notebook(Array.from({ length: 25 }, (_, index) => code(`lesson_${index + 1} = True`))), 'many.ipynb');
  assert.equal(source.cells.length, 20);
  assert.equal(source.endCell, 20);
  assert.equal(source.omittedCells, 5);
  assert.equal(source.truncated, true);
  const later = extractNotebookSource(notebook(Array.from({ length: 25 }, (_, index) => code(`lesson_${index + 1} = True`))), 'many.ipynb', { startCell: 21 });
  assert.deepEqual(later.cells.map(cell => cell.cell), [21, 22, 23, 24, 25]);
  assert.match(later.content, /many\.ipynb#cell-21:source-1/);
  const large = extractNotebookSource(notebook([code('x'.repeat(30_000)), code('line\n'.repeat(500))]), 'bounded.ipynb');
  assert.ok(large.content.length <= NOTEBOOK_LIMITS.maxOutputChars);
  assert.ok(large.cells.every(cell => cell.truncated));
  assert.ok(large.cells[1]!.endLine <= NOTEBOOK_LIMITS.maxCellLines);
  assert.match(large.content, /Cell source shortened/);
  assert.equal(large.truncated, true);
});

test('the notebook format and every recognized cell source are validated without leaking malformed data', () => {
  const malformed = [
    '{ PRIVATE_INVALID_JSON', JSON.stringify(null), JSON.stringify([]), notebook([], { nbformat: 3 }), notebook([], { nbformat_minor: -1 }),
    notebook([], { cells: {} }), notebook([null]), notebook([{}]), notebook([code(null)]), notebook([code(['safe', 42])]),
    notebook([code({ PRIVATE_OBJECT_SOURCE: true })]), notebook([code('a\u0000b')]),
    notebook([code('safe'), code(false)]),
  ];
  for (const json of malformed) assert.throws(() => extractNotebookSource(json, 'bad.ipynb', { startCell: 1, endCell: 1 }), error => {
    assert.ok(error instanceof LittleError);
    assert.equal(error.code, 'TOOL_FAILED');
    assert.equal(error.message.includes('PRIVATE_'), false);
    return true;
  });
});

test('empty notebooks, empty source and unsupported cell types remain explicit read-only source results', () => {
  const empty = extractNotebookSource(notebook([]), 'empty.ipynb');
  assert.equal(empty.totalCells, 0);
  assert.deepEqual(empty.cells, []);
  assert.match(empty.content, /No code or markdown source/);
  const source = extractNotebookSource(notebook([code([]), { cell_type: 'future-cell', source: 'PRIVATE_UNSUPPORTED' }]), 'future.ipynb');
  assert.equal(source.cells[0]!.totalLines, 1);
  assert.equal(source.omittedCellTypes, 1);
  assert.equal(source.content.includes('PRIVATE_UNSUPPORTED'), false);
});

test('input bytes, source line count and cell count have independent bounded failure guards', () => {
  assert.throws(() => extractNotebookSource(' '.repeat(NOTEBOOK_LIMITS.maxFileBytes + 1), 'large.ipynb'), isError('CONTEXT_LIMIT'));
  assert.throws(() => extractNotebookSource(notebook(Array.from({ length: NOTEBOOK_LIMITS.maxCells + 1 }, () => code(''))), 'many.ipynb'), isError('CONTEXT_LIMIT'));
  assert.throws(() => extractNotebookSource(notebook([code('\n'.repeat(NOTEBOOK_LIMITS.maxSourceLines))]), 'lines.ipynb'), isError('CONTEXT_LIMIT'));
});

test('cell ranges require bounded positive ordered integers and reject an unavailable starting cell', () => {
  assert.deepEqual(notebookCellRange({ startCell: 30 }), { startCell: 30, endCell: 49 });
  for (const range of [{ startCell: 0 }, { startCell: -1 }, { startCell: 1.5 }, { endCell: 0 }, { startCell: 3, endCell: 2 },
    { startCell: 1, endCell: 21 }, { startCell: 10_001 }, { endCell: Infinity }]) {
    assert.throws(() => notebookCellRange(range), isError('TOOL_VALIDATION_FAILED'));
  }
  assert.throws(() => extractNotebookSource(notebook([code('x = 1')]), 'one.ipynb', { startCell: 2 }), isError('TOOL_VALIDATION_FAILED'));
});

test('read_notebook keeps its native typed schema and strict host validation with optional fields omitted', async () => {
  const calls: { path: string; signal?: AbortSignal }[] = [];
  const reader: NotebookWorkspaceReader = { async readNotebookFile(path, signal) {
    calls.push({ path, signal });
    const content = notebook([code('real_source = 1')]);
    return { path, content, bytesRead: Buffer.byteLength(content), totalBytes: Buffer.byteLength(content), truncated: false };
  } };
  const tool = createNotebookTools(reader)[0]!;
  assert.equal(tool.name, 'read_notebook');
  assert.equal(tool.risk, 'SAFE');
  assert.equal(tool.parameters.type, 'object');
  assert.equal(tool.parameters.additionalProperties, false);
  assert.deepEqual(tool.parameters.required, ['path']);
  const properties = tool.parameters.properties as Record<string, Record<string, unknown>>;
  assert.equal(properties.path!.type, 'string');
  assert.equal(properties.startCell!.type, 'integer');
  assert.equal(properties.startCell!.default, 1);
  assert.equal(properties.endCell!.type, 'integer');
  const args = { path: 'lesson.ipynb' };
  assert.deepEqual(tool.validate(args), { path: 'lesson.ipynb', startCell: 1, endCell: 20 });
  const selectedSignal = signal();
  const result = await tool.execute(args, { signal: selectedSignal });
  assert.match(JSON.stringify(result), /real_source/);
  assert.deepEqual(calls, [{ path: 'lesson.ipynb', signal: selectedSignal }]);
  for (const input of [{ path: 'lesson.py' }, { path: 'lesson.ipynb', command: 'execute' }, { path: 'lesson.ipynb', startCell: 5, endCell: 1 },
    { path: 'lesson.ipynb', endCell: 21 }, { path: 'bad\u0000.ipynb' }]) {
    assert.throws(() => tool.validate(input), isError('TOOL_VALIDATION_FAILED'));
    await assert.rejects(tool.execute(input, { signal: signal() }), isError('TOOL_VALIDATION_FAILED'));
  }
  assert.equal(calls.length, 1);
});

test('a previously truncated JSON response and cancellation never expose partial notebook source', async () => {
  await assert.rejects(readNotebookSource({ async readNotebookFile() {
    return { path: 'lesson.ipynb', content: '{ PRIVATE_TRUNCATED', truncated: true, bytesRead: 20_000, totalBytes: 60_000 };
  } }, 'lesson.ipynb'), isError('CONTEXT_LIMIT'));
  const controller = new AbortController(); controller.abort();
  let reads = 0;
  const reader: NotebookWorkspaceReader = { async readNotebookFile() { reads++; throw new Error('Must not read after cancellation.'); } };
  assert.throws(() => extractNotebookSource(notebook([code('safe')]), 'lesson.ipynb', {}, controller.signal), isError('AGENT_CANCELLED'));
  await assert.rejects(readNotebookSource(reader, 'lesson.ipynb', {}, controller.signal), isError('AGENT_CANCELLED'));
  assert.equal(reads, 0);
});

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'little-notebook-source-'));
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative.startsWith('little-notebook-source-') && !relative.includes(path.sep));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, workspace: new WorkspaceService(root) };
}

test('the protected notebook reader accepts complete notebooks beyond ordinary text limits while excluding large outputs', async t => {
  const { root, workspace } = await fixture(t);
  const content = notebook([code('current_notebook_source = 7', { outputs: [{ output_type: 'display_data', data: { 'image/png': 'PRIVATE_IMAGE_DATA'.repeat(50_000) } }] })]);
  await fs.writeFile(path.join(root, 'large.ipynb'), content);
  const reader: NotebookWorkspaceReader = workspace;
  assert.equal(typeof reader.readNotebookFile, 'function', 'Notebook access requires the protected complete JSON reader.');
  const source = await readNotebookSource(reader, 'large.ipynb', {}, signal());
  assert.ok(source.bytesRead > 256 * 1024);
  assert.equal(source.bytesRead, Buffer.byteLength(content));
  assert.equal(source.totalBytes, source.bytesRead);
  assert.match(source.content, /current_notebook_source = 7/);
  assert.equal(source.content.includes('PRIVATE_IMAGE_DATA'), false);
  assert.ok(source.content.length < 2000);
  assert.equal(await fs.readFile(path.join(root, 'large.ipynb'), 'utf8'), content, 'Inspection must not alter or execute the notebook.');
});

test('current workspace ignore, sensitive-path and boundary policy also apply to notebook inspection', async t => {
  const { root, workspace } = await fixture(t);
  await fs.writeFile(path.join(root, 'ignored.ipynb'), notebook([code('PRIVATE_IGNORED')]));
  await fs.writeFile(path.join(root, 'policy.ipynb'), notebook([code('private_policy_source')]));
  await fs.mkdir(path.join(root, '.aws'));
  await fs.writeFile(path.join(root, '.aws', 'lesson.ipynb'), notebook([code('PRIVATE_SENSITIVE')]));
  await fs.writeFile(path.join(root, '.gitignore'), 'ignored.ipynb\n');
  const reader: NotebookWorkspaceReader = workspace;
  await assert.rejects(readNotebookSource(reader, 'ignored.ipynb'), isError('PERMISSION_DENIED'));
  await assert.rejects(readNotebookSource(reader, '.aws/lesson.ipynb'), isError('PERMISSION_DENIED'));
  await assert.rejects(readNotebookSource(reader, '../outside.ipynb'), isError('WORKSPACE_BOUNDARY_VIOLATION'));
  assert.match((await readNotebookSource(reader, 'policy.ipynb')).content, /private_policy_source/);
  await fs.writeFile(path.join(root, '.littleignore'), 'policy.ipynb\n');
  await assert.rejects(readNotebookSource(reader, 'policy.ipynb'), isError('PERMISSION_DENIED'));
});

test('protected notebook input rejects oversized and binary files before returning source', async t => {
  const { root, workspace } = await fixture(t);
  await fs.writeFile(path.join(root, 'oversized.ipynb'), ' '.repeat(NOTEBOOK_LIMITS.maxFileBytes + 1));
  await fs.writeFile(path.join(root, 'invalid-utf8.ipynb'), new Uint8Array([0xff, 0xfe, 0xfa]));
  await fs.writeFile(path.join(root, 'binary.ipynb'), new Uint8Array([0x7b, 0x00, 0x7d]));
  await assert.rejects(readNotebookSource(workspace, 'oversized.ipynb'), isError('CONTEXT_LIMIT'));
  await assert.rejects(readNotebookSource(workspace, 'invalid-utf8.ipynb'), isError('TOOL_FAILED'));
  await assert.rejects(readNotebookSource(workspace, 'binary.ipynb'), isError('TOOL_FAILED'));
});
