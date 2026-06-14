import type { ChannelAdapter, ChannelContext } from "./types.js";

export class WebChannel implements ChannelAdapter {
  readonly type = "web" as const;

  isConfigured(): boolean {
    return true;
  }

  async healthCheck() {
    return { ok: true };
  }

  async deliver(_context: ChannelContext): Promise<void> {
    // Web tasks are visible immediately in the authenticated human inbox.
  }
}
