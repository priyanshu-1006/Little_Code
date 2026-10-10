import type { RuntimeEvent } from '../shared/contracts';
export class EventBus {
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) {
      // A disconnected UI must not interrupt the agent.
      try { listener(event); } catch { /* isolate consumers */ }
    }
  }
}
