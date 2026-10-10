import type { AgentMode, ToolRisk } from '../shared/contracts';

/** Deny by default. New modes need an explicit policy before capabilities can grow. */
export class PermissionEngine {
  evaluate(mode: AgentMode, risk: ToolRisk): boolean {
    if (mode === 'ask' || mode === 'plan') return risk === 'SAFE';
    // Host-owned review gates still approve each edit and command separately.
    if (mode === 'agent') return risk === 'SAFE' || risk === 'WORKSPACE_WRITE' || risk === 'EXECUTION';
    // Edit tools can only stage proposals. Applying still requires a host-owned acceptance.
    return mode === 'edit' && (risk === 'SAFE' || risk === 'WORKSPACE_WRITE');
  }
}
