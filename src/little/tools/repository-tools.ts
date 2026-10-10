import { z } from 'zod';
import type { RepositoryIndex } from '../context/repository-index';
import { rankRepositoryFiles } from '../context/retrieve-context';
import { redactSecrets } from '../context/redact-secrets';
import type { AgentTool, EditorService, RepositoryStatus, ToolContext } from '../shared/contracts';
import { LittleError } from '../shared/errors';
import { assertNotAborted } from './workspace-service';

const MAX_OUTPUT = 18_000;
const mapSchema = z.object({ limit: z.number().int().min(1).max(100).default(40) }).strict();
const querySchema = z.object({ query: z.string().trim().min(1).max(2000), limit: z.number().int().min(1).max(12).default(6) }).strict();
const symbolSchema = z.object({ query: z.string().trim().min(1).max(128), limit: z.number().int().min(1).max(50).default(25) }).strict();

function tool<T>(name: string, description: string, schema: z.ZodType<T>, execute: (input: T, context: ToolContext) => Promise<unknown>): AgentTool {
  const validate = (input: unknown): T => {
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw new LittleError('TOOL_VALIDATION_FAILED', `Invalid arguments for ${name}.`);
    return parsed.data;
  };
  return { name, description, risk: 'SAFE', parameters: z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>, validate,
    async execute(input, context) {
      assertNotAborted(context.signal);
      const output = await execute(validate(input), context);
      assertNotAborted(context.signal);
      return output;
    } };
}

function bounded<T>(records: T[], total: number, generation: number, truncated: boolean) {
  const result = { provenance: 'Local source heuristics; read_file or read_range must verify current code. This is not an AST or a complete symbol graph.', generation, total, truncated: truncated || records.length < total, matches: records };
  while (JSON.stringify(result).length > MAX_OUTPUT && result.matches.length) { result.matches.pop(); result.truncated = true; }
  return result;
}

/** Metadata tools never count as the Agent's required source inspection. Each call refreshes workspace policy. */
export function createRepositoryTools(editor: EditorService, index: RepositoryIndex, onProgress?: (status: RepositoryStatus) => void): AgentTool[] {
  return [
    tool('get_repository_map', 'Read a bounded local map of source files, heuristic declarations, and static imports. Ignores and file metadata are refreshed before every query. Verify code using read_file or read_range.', mapSchema, async (input, context) => {
      const snapshot = await index.refresh(context.signal, onProgress);
      const records = snapshot.files.slice(0, input.limit).map(file => ({ path: file.path, language: file.language,
        symbols: file.symbols.slice(0, 8), imports: file.imports.slice(0, 6), metadataLimited: file.symbols.length > 8 || file.imports.length > 6 }));
      return bounded(records, snapshot.files.length, snapshot.generation, snapshot.truncated);
    }),
    tool('find_relevant_files', 'Rank permitted project files for a task using paths, identifiers, declarations, editor context, and relative imports. Returns reasons, not source. Follow up with read_file or read_range.', querySchema, async (input, context) => {
      const snapshot = await index.refresh(context.signal, onProgress);
      const candidates = rankRepositoryFiles(snapshot, redactSecrets(input.query), editor.snapshot(), { limit: 12 });
      return bounded(candidates.slice(0, input.limit), candidates.length, snapshot.generation, snapshot.truncated || candidates.length === 12);
    }),
    tool('search_symbol', 'Find heuristic function, class, interface, type, and variable declarations by literal name, case-insensitively. Lines are one-based hints. Verify with read_range; overloaded or dynamic declarations may be missing.', symbolSchema, async (input, context) => {
      const snapshot = await index.refresh(context.signal, onProgress);
      const query = redactSecrets(input.query).toLowerCase();
      const matches = snapshot.files.flatMap(file => file.symbols.filter(symbol => symbol.name.toLowerCase().includes(query)).map(symbol => ({ path: file.path, ...symbol })));
      return bounded(matches.slice(0, input.limit), matches.length, snapshot.generation, snapshot.truncated);
    }),
  ];
}
