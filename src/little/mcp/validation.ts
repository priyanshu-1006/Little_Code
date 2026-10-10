import { redactSecrets } from '../context/redact-secrets';
import { LittleError } from '../shared/errors';

export type McpErrorCode = 'MCP_CONFIG_INVALID' | 'MCP_PROTOCOL_ERROR' | 'MCP_UNAVAILABLE' | 'MCP_TIMEOUT' | 'MCP_CANCELLED' | 'MCP_SERVER_ERROR' | 'MCP_INPUT_INVALID' | 'MCP_NOT_CONNECTED' | 'MCP_TOOL_FAILED' | 'MCP_RESPONSE_LIMIT' | 'MCP_HEADER_INVALID';
export class McpError extends LittleError {
  constructor(readonly mcpCode: McpErrorCode, message: string) {
    super(mcpCode === 'MCP_CANCELLED' ? 'AGENT_CANCELLED' : ['MCP_CONFIG_INVALID', 'MCP_INPUT_INVALID'].includes(mcpCode) ? 'TOOL_VALIDATION_FAILED' : 'TOOL_FAILED', message);
    this.name = 'McpError';
  }
}
export type JsonObject = Record<string, unknown>;
export function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SENSITIVE_KEYS = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|passwd|secret|private[_-]?key|credential)$/i;

/** Credentials never become provider context or transport diagnostics. */
export function assertSafeJson(value: unknown, maxString = 65536): void {
  let nodes = 0;
  const visit = (entry: unknown, depth: number): void => {
    if (++nodes > 10000 || depth > 16) throw new McpError('MCP_RESPONSE_LIMIT', 'MCP data exceeded the supported size or nesting limit.');
    if (typeof entry === 'string') {
      if (entry.length > maxString) throw new McpError('MCP_RESPONSE_LIMIT', 'MCP text exceeded the supported size limit.');
      if (redactSecrets(entry) !== entry) throw new McpError('MCP_PROTOCOL_ERROR', 'MCP data contains potential credentials and was blocked.');
      return;
    }
    if (typeof entry === 'number' && !Number.isFinite(entry)) throw new McpError('MCP_PROTOCOL_ERROR', 'MCP returned an invalid number.');
    if (entry === null || typeof entry === 'number' || typeof entry === 'boolean') return;
    if (Array.isArray(entry)) { if (entry.length > 2048) throw new McpError('MCP_RESPONSE_LIMIT', 'MCP collection exceeded the supported size limit.'); for (const item of entry) visit(item, depth + 1); return; }
    const record = object(entry);
    if (!record || Object.getPrototypeOf(record) !== Object.prototype) throw new McpError('MCP_PROTOCOL_ERROR', 'MCP returned unsupported data.');
    const entries = Object.entries(record);
    if (entries.length > 128) throw new McpError('MCP_RESPONSE_LIMIT', 'MCP object exceeded the supported size limit.');
    for (const [key, child] of entries) {
      if (UNSAFE_KEYS.has(key) || key.length > 256) throw new McpError('MCP_PROTOCOL_ERROR', 'MCP returned an unsafe property.');
      if (SENSITIVE_KEYS.test(key) && (typeof child === 'string' || typeof child === 'number') && String(child).length) throw new McpError('MCP_PROTOCOL_ERROR', 'MCP data contains potential credentials and was blocked.');
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
}

const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const KEYS = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title', '$schema', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties', 'x-mcp-header']);
const SIZE_KEYS = ['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties'];
function schemaError(): McpError { return new McpError('MCP_PROTOCOL_ERROR', 'This MCP tool uses an invalid or unsupported JSON Schema. References, combinators, patterns, and schema-valued additionalProperties are not supported.'); }
const scalar = (value: unknown): boolean => value === null || ['string', 'boolean'].includes(typeof value) || typeof value === 'number' && Number.isFinite(value);

/** Deliberately small, fail-closed JSON Schema subset; no remote $ref resolution. */
export function validateMcpSchema(schema: unknown): JsonObject {
  assertSafeJson(schema, 32768);
  if (JSON.stringify(schema).length > 32768) throw schemaError();
  let nodes = 0;
  const headers = new Set<string>();
  const visit = (entry: unknown, depth: number, propertyPath: boolean): void => {
    const node = object(entry);
    if (!node || ++nodes > 256 || depth > 8 || Object.keys(node).some(key => !KEYS.has(key)) || typeof node.type !== 'string' || !TYPES.has(node.type)) throw schemaError();
    for (const key of ['description', 'title']) if (node[key] !== undefined && (typeof node[key] !== 'string' || (node[key] as string).length > 1000)) throw schemaError();
    if (node.$schema !== undefined && (typeof node.$schema !== 'string' || !['https://json-schema.org/draft/2020-12/schema', 'http://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft-07/schema#'].includes(node.$schema))) throw schemaError();
    for (const key of SIZE_KEYS) if (node[key] !== undefined && (typeof node[key] !== 'number' || !Number.isSafeInteger(node[key]) || (node[key] as number) < 0 || (node[key] as number) > 65536)) throw schemaError();
    for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) if (node[key] !== undefined && (typeof node[key] !== 'number' || !Number.isFinite(node[key]))) throw schemaError();
    for (const [minimum, maximum] of [['minLength', 'maxLength'], ['minItems', 'maxItems'], ['minProperties', 'maxProperties'], ['minimum', 'maximum']]) if (typeof node[minimum!] === 'number' && typeof node[maximum!] === 'number' && (node[minimum!] as number) > (node[maximum!] as number)) throw schemaError();
    if (node.enum !== undefined && (!Array.isArray(node.enum) || !node.enum.length || node.enum.length > 50 || !node.enum.every(scalar) || new Set(node.enum.map(value => JSON.stringify(value))).size !== node.enum.length)) throw schemaError();
    if (node.const !== undefined && !scalar(node.const)) throw schemaError();
    if (node['x-mcp-header'] !== undefined) {
      const header = node['x-mcp-header'];
      if (!propertyPath || depth === 0 || !['string', 'integer', 'boolean'].includes(node.type) || typeof header !== 'string' || header.length > 64 || !/^[!#$%&'*+.^_`|~A-Za-z0-9-]+$/.test(header) || /[\r\n]/.test(header) || headers.has(header.toLowerCase())) throw new McpError('MCP_HEADER_INVALID', 'MCP tool contains an invalid parameter header annotation and was excluded.');
      headers.add(header.toLowerCase());
    }
    if (node.type === 'object') {
      const properties = node.properties === undefined ? {} : object(node.properties);
      if (!properties || Object.keys(properties).length > 64) throw schemaError();
      for (const [name, child] of Object.entries(properties)) { if (!name || name.length > 64 || UNSAFE_KEYS.has(name)) throw schemaError(); visit(child, depth + 1, propertyPath); }
      if (node.required !== undefined && (!Array.isArray(node.required) || node.required.length > 64 || node.required.some(key => typeof key !== 'string' || !Object.hasOwn(properties, key)) || new Set(node.required).size !== node.required.length)) throw schemaError();
      if (node.additionalProperties !== undefined && typeof node.additionalProperties !== 'boolean') throw schemaError();
    } else if (node.properties !== undefined || node.required !== undefined || node.additionalProperties !== undefined || node.minProperties !== undefined || node.maxProperties !== undefined) throw schemaError();
    if (node.type === 'array') { if (node.items === undefined) throw schemaError(); visit(node.items, depth + 1, false); }
    else if (node.items !== undefined || node.minItems !== undefined || node.maxItems !== undefined) throw schemaError();
    if (node.type !== 'string' && (node.minLength !== undefined || node.maxLength !== undefined)) throw schemaError();
    if (!['number', 'integer'].includes(node.type) && ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'].some(key => node[key] !== undefined)) throw schemaError();
  };
  visit(schema, 0, true);
  if (object(schema)?.type !== 'object') throw schemaError();
  return JSON.parse(JSON.stringify(schema)) as JsonObject;
}

export function validateMcpInput(schema: JsonObject, args: unknown): JsonObject {
  const checkedSchema = validateMcpSchema(schema);
  const fail = (): never => { throw new McpError('MCP_INPUT_INVALID', 'MCP tool arguments do not match the tool’s supported input schema.'); };
  try { assertSafeJson(args, 8192); } catch { return fail(); }
  if (!object(args) || JSON.stringify(args).length > 32768) return fail();
  const visit = (node: JsonObject, value: unknown): void => {
    if (node.enum !== undefined && !(node.enum as unknown[]).some(item => item === value)) return fail();
    if (Object.hasOwn(node, 'const') && node.const !== value) return fail();
    switch (node.type) {
      case 'object': {
        const record = object(value); if (!record) return fail();
        const properties = object(node.properties) ?? {};
        const keys = Object.keys(record);
        if (typeof node.minProperties === 'number' && keys.length < node.minProperties || typeof node.maxProperties === 'number' && keys.length > node.maxProperties) return fail();
        if ((node.required as string[] | undefined)?.some(key => !Object.hasOwn(record, key))) return fail();
        for (const key of keys) { const child = object(properties[key]); if (child) visit(child, record[key]); else if (node.additionalProperties === false) return fail(); }
        break;
      }
      case 'array':
        if (!Array.isArray(value) || typeof node.minItems === 'number' && value.length < node.minItems || typeof node.maxItems === 'number' && value.length > node.maxItems) return fail();
        for (const entry of value) visit(node.items as JsonObject, entry);
        break;
      case 'string':
        if (typeof value !== 'string' || typeof node.minLength === 'number' && [...value].length < node.minLength || typeof node.maxLength === 'number' && [...value].length > node.maxLength) return fail();
        break;
      case 'number':
      case 'integer':
        if (typeof value !== 'number' || !Number.isFinite(value) || node.type === 'integer' && !Number.isSafeInteger(value)) return fail();
        if (typeof node.minimum === 'number' && value < node.minimum || typeof node.maximum === 'number' && value > node.maximum || typeof node.exclusiveMinimum === 'number' && value <= node.exclusiveMinimum || typeof node.exclusiveMaximum === 'number' && value >= node.exclusiveMaximum) return fail();
        break;
      case 'boolean': if (typeof value !== 'boolean') return fail(); break;
      case 'null': if (value !== null) return fail(); break;
      default: return fail();
    }
  };
  visit(checkedSchema, args);
  return JSON.parse(JSON.stringify(args)) as JsonObject;
}
