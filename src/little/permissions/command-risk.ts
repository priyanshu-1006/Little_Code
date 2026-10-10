import type { ToolRisk } from '../shared/contracts';

export interface CommandRiskRule { id: string; risk: ToolRisk; matches(command: string): boolean }

export const DEFAULT_COMMAND_RISK_RULES: readonly CommandRiskRule[] = Object.freeze([
  { id: 'shell-composition', risk: 'DANGEROUS', matches: (command) => /[;&|<>\r\n`]|\$\(|%[^%]+%|\$\{/.test(command) },
  { id: 'destructive', risk: 'DANGEROUS', matches: (command) => /(?:^|\s)(?:rm|rmdir|del|erase|remove-item|format|mkfs|shutdown|reboot|sudo|runas)(?:\s|$)|\bgit\s+(?:push|clean|reset|checkout|restore)\b|\b(?:deploy|publish)\b/i.test(command) },
  { id: 'outside-path', risk: 'DANGEROUS', matches: (command) => /(?:^|\s|=)(?:\.\.[\\/]|[A-Za-z]:[\\/]|\\\\|~[\\/])/.test(command) },
  { id: 'credentials', risk: 'SENSITIVE', matches: (command) => /(?:\.env\b|credentials?|secrets?|id_rsa|id_ed25519|\.pem\b|\.key\b)/i.test(command) },
  { id: 'package-change', risk: 'SENSITIVE', matches: (command) => /\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|remove|uninstall|update|upgrade|exec|dlx)\b|\b(?:pip|pip3|cargo|gem)\s+(?:install|uninstall|update)\b|\bnpx\b/i.test(command) },
  { id: 'external-or-environment', risk: 'SENSITIVE', matches: (command) => /\b(?:curl|wget|invoke-webrequest|invoke-restmethod|setx|export|git\s+(?:commit|fetch|pull|clone|config))\b/i.test(command) },
  { id: 'git-observation', risk: 'SAFE', matches: (command) => /^git\s+(?:status(?:\s+(?:--short|--porcelain(?:=v2)?|--branch|-s|-b))*|diff(?:\s+(?:--stat|--numstat|--name-only|--name-status|--check|--cached|--staged))*)$/i.test(command) },
]);

const RISK_ORDER: Record<ToolRisk, number> = { SAFE: 0, WORKSPACE_WRITE: 1, EXECUTION: 2, SENSITIVE: 3, DANGEROUS: 4 };

/** Conservative classification only. It is never an authorization to execute a shell. */
export function classifyCommand(command: string, rules: readonly CommandRiskRule[] = DEFAULT_COMMAND_RISK_RULES): ToolRisk {
  if (!command.trim() || command.length > 8_192 || command.includes('\u0000')) return 'DANGEROUS';
  let matched: ToolRisk | undefined;
  for (const rule of rules) {
    if (rule.matches(command.trim()) && (matched === undefined || RISK_ORDER[rule.risk] > RISK_ORDER[matched])) matched = rule.risk;
  }
  return matched ?? 'EXECUTION';
}
