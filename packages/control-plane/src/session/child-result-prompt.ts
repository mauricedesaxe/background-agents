import type { ChildSessionDetail } from "@open-inspect/shared/types/session-api";

export function buildChildResultPrompt(childSessionId: string, detail: ChildSessionDetail): string {
  const title = detail.session.title || childSessionId;
  const status = detail.session.status;
  const lines = [`Subtask "${title}" finished with status: ${status}.`];

  const finalResponse = detail.finalResponse;
  if (finalResponse) {
    if (finalResponse.textContent.trim().length > 0) {
      lines.push("", finalResponse.textContent.trim());
    }
    if (finalResponse.error) {
      lines.push("", `Error: ${finalResponse.error}`);
    }
  }

  const pullRequests = detail.artifacts.filter((artifact) => artifact.type === "pr");
  for (const pr of pullRequests) {
    if (pr.url) lines.push("", `Pull request: ${pr.url}`);
  }

  return lines.join("\n");
}
