/**
 * Formats a dispatched agent's session-end summary as a Markdown approval
 * comment body (rendered by the existing MarkdownBody comment UI — no new
 * rendering path needed). DID is required; PR/head SHA and LEFT are optional
 * since not every close-out has a PR or outstanding work.
 */
export interface CloseOutCommentInput {
  did: string;
  prUrl?: string | null;
  headSha?: string | null;
  left?: string | null;
}

export function formatCloseOutComment(input: CloseOutCommentInput): string {
  const lines = ["**Close-out**", "", `- **DID:** ${input.did}`];

  if (input.prUrl) {
    const sha = input.headSha ? ` (\`${input.headSha}\`)` : "";
    lines.push(`- **PR:** ${input.prUrl}${sha}`);
  } else if (input.headSha) {
    lines.push(`- **PR:** \`${input.headSha}\``);
  }

  lines.push(`- **LEFT:** ${input.left?.trim() ? input.left : "Nothing outstanding."}`);

  return lines.join("\n");
}
