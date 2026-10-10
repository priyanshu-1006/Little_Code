import { z } from 'zod';
import { getActiveFileContext, getDiagnosticsContext, getSelectionContext } from '../context/editor-context';
import type { AgentTool, EditorService, ToolContext } from '../shared/contracts';
import { LittleError } from '../shared/errors';
import { assertNotAborted, WORKSPACE_LIMITS, type WorkspaceService } from './workspace-service';

const pathSchema = z.string().min(1).max(4_096).refine((value) => !/[\u0000-\u001f]/.test(value), 'Paths cannot contain control characters.');
const emptySchema = z.object({}).strict();
const optionalPathSchema = z.object({ path: pathSchema.default('.') }).strict();
const requiredPathSchema = z.object({ path: pathSchema }).strict();
const rangeSchema = z.object({ path: pathSchema, startLine: z.number().int().min(1), endLine: z.number().int().min(1) }).strict()
  .refine((value) => value.endLine >= value.startLine && value.endLine - value.startLine + 1 <= WORKSPACE_LIMITS.maxRangeLines, `Ranges must contain 1 to ${WORKSPACE_LIMITS.maxRangeLines} ordered lines.`);
const filesSchema = z.object({ query: z.string().min(1).max(128) }).strict();
const textSchema = z.object({ query: z.string().min(1).max(256), path: pathSchema.default('.'), caseSensitive: z.boolean().default(false) }).strict();

function makeTool<T>(name: string, description: string, schema: z.ZodType<T>, execute: (input: T, context: ToolContext) => Promise<unknown>): AgentTool {
  const validate = (input: unknown): T => {
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw new LittleError('TOOL_VALIDATION_FAILED', `Invalid arguments for ${name}: ${parsed.error.issues.slice(0, 3).map((issue) => issue.message).join(' ')}`);
    return parsed.data;
  };
  return {
    name, description, risk: 'SAFE',
    parameters: z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>,
    validate,
    async execute(input, context) {
      assertNotAborted(context.signal);
      const result = await execute(validate(input), context);
      assertNotAborted(context.signal);
      return result;
    },
  };
}

export function createReadOnlyTools(workspace: WorkspaceService, editor: EditorService): AgentTool[] {
  return [
    makeTool('get_workspace_info', 'Read the workspace name, top-level paths, and context limits. Sensitive and ignored paths are excluded.', emptySchema, async (_, context) => workspace.info(context.signal)),
    makeTool('list_directory', 'List a workspace directory. Uses .gitignore and .littleignore and returns a bounded listing.', optionalPathSchema, async (input, context) => workspace.listDirectory(input.path, context.signal)),
    makeTool('read_file', 'Read a workspace UTF-8 file or extract notebook/document source. Prefer read_notebook for .ipynb cells and read_document for DOCX/PPTX/PDF ranges. Sensitive paths are denied, secrets redacted, results bounded.', requiredPathSchema, async (input, context) => workspace.readFile(input.path, context.signal)),
    makeTool('inspect_file', 'Inspect a regular workspace file: size, extension and exact-byte SHA-256, up to 16 MiB. Returns no content. Use for deletion evidence or unsupported binary metadata; never treat it as a content read.', requiredPathSchema, async (input, context) => workspace.inspectFile(input.path, context.signal)),
    makeTool('read_range', 'Read an inclusive, one-based line range of a workspace source file, up to 400 lines. Large files and sensitive paths are excluded.', rangeSchema, async (input, context) => workspace.readRange(input.path, input.startLine, input.endLine, context.signal)),
    makeTool('search_files', 'Find workspace file paths containing a literal query, case-insensitively. Ignored, generated, and sensitive paths are excluded.', filesSchema, async (input, context) => workspace.searchFiles(input.query, context.signal)),
    makeTool('search_text', 'Find literal text in workspace UTF-8 files, with one-based line numbers and bounded redacted previews. Supports optional case sensitivity and a directory or file path.', textSchema, async (input, context) => workspace.searchText(input.query, input.path, context.signal, input.caseSensitive)),
    makeTool('get_active_file', 'Read the active editor file and its current unsaved content when available. Workspace restrictions and secret redaction apply.', emptySchema, async (_, context) => getActiveFileContext(workspace, editor, context.signal)),
    makeTool('get_selection', 'Read selected code from a permitted active workspace file. Secret redaction and context limits apply.', emptySchema, async (_, context) => getSelectionContext(workspace, editor, context.signal)),
    makeTool('get_diagnostics', 'Read bounded, redacted diagnostics from permitted workspace files. Sensitive, ignored, outside, and unparseable sources are omitted.', emptySchema, async (_, context) => getDiagnosticsContext(workspace, editor, context.signal)),
  ];
}
