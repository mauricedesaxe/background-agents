import type { ContextResetPromptHold } from "../../prompt-hold-service";

/**
 * Releases the context-reset hold the runtime handler applied to the queued
 * prompt, then lets it dispatch with the reset already noted on the timeline.
 * A request with nothing held answers 409, so a double-clicked acknowledge or
 * a race against a cancel cannot report a release that did not happen.
 */
export class ContextResetHandler {
  constructor(private readonly promptHold: ContextResetPromptHold) {}

  async acknowledgeContextReset(): Promise<Response> {
    const { released, acknowledged } = await this.promptHold.releaseQueuedPromptHold();
    if (!acknowledged) {
      return Response.json({ error: "No context-reset hold to acknowledge" }, { status: 409 });
    }
    return Response.json({ status: "released", released });
  }
}
