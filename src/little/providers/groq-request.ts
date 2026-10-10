import type { LLMRequest } from '../shared/contracts';


import { groqReasoningOptions } from './groq-models';

/** Native local function calling. The transport and budget must measure this identical body. */
export function groqNativeRequest(request: LLMRequest) {
  return {
    model: request.model,
    messages: request.messages.map(message => ({ role: message.role, content: message.content,
      ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
      ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map(call => ({ id: call.id, type: 'function',
        function: { name: call.name, arguments: call.arguments } })) } : {}) })),
    stream: true, stream_options: { include_usage: true }, ...groqReasoningOptions(request.model),
    ...(request.maxOutputTokens === undefined ? {} : { max_completion_tokens: request.maxOutputTokens }),
    ...(request.tools?.length ? { tools: request.tools.map(tool => ({ type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters } })), tool_choice: 'auto',
      ...(['openai/gpt-oss-20b', 'openai/gpt-oss-120b'].includes(request.model) ? { parallel_tool_calls: false } : {}) } : {}),
  };
}
