/** Conservative preprocessing boundary for every piece of model-facing source text. */
export function redactSecrets(text: string): string {
  return text
    .replace(/-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?(?:-----END(?: [A-Z0-9]+)* PRIVATE KEY-----|$)/g, (block) => block.split('\n').map((_, index) => index === 0 ? '[REDACTED PRIVATE KEY]' : '[REDACTED]').join('\n'))
    .replace(/\b(?:gsk_[A-Za-z0-9_-]{12,}|sk-(?:proj-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED TOKEN]')
    .replace(/(\b(?:authorization\s*:\s*["']?bearer|bearer)\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/(["']?\b[A-Za-z0-9_-]{0,64}(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|private[_-]?key|token|secret|password|passwd|credential)[A-Za-z0-9_-]{0,64}\b["']?\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;\r\n}]+)/gi, '$1[REDACTED]')
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:)[^\s/@]+(@)/gi, '$1[REDACTED]$2');
}
