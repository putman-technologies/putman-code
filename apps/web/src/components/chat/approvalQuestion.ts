import type { MessageId, RunId, ScopedThreadRef } from "@t3tools/contracts";
import { parseMarkdownWithMath } from "@t3tools/shared/markdownMath";
import type { PhrasingContent } from "mdast";

const request =
  /(?:^|[.!]\s+)((?:do you (?:approve\b|authorize\b|want me to\b)|would you like me to\b|(?:may|can|should|shall) I\b|can you (?:approve|confirm)\b|is it (?:okay|ok) (?:if I|for me to)\b)[^?]*\?)/iu;

function prose(node: PhrasingContent, mask: boolean): string {
  if (node.type === "text") return node.value;
  if (node.type === "break") return " ";
  if (node.type === "strong" || node.type === "emphasis")
    return node.children.map((child) => prose(child, mask)).join("");
  const value =
    node.type === "inlineCode"
      ? node.value
      : node.type === "link" || node.type === "linkReference"
        ? node.children.map((child) => prose(child, false)).join("")
        : "\uFFFC";
  return mask && value !== "\uFFFC" ? "·".repeat(value.length) : value;
}

/** Only an assistant's own closing prose can offer a conversational reply. */
export function readApprovalQuestion(markdown: string): string | null {
  if (!markdown.includes("?")) return null;
  const last = parseMarkdownWithMath(markdown).children.at(-1);
  if (last?.type !== "paragraph") return null;
  const masked = last.children.map((node) => prose(node, true)).join("");
  if (masked.indexOf("?") !== masked.lastIndexOf("?")) return null;
  const match = request.exec(masked);
  const wording = match?.[1];
  if (!match || !wording || /\bor\b|\uFFFC/i.test(wording) || /[.!]\s+\p{Lu}/u.test(wording))
    return null;
  const end = match.index + match[0].length;
  const after = masked.slice(end).trim();
  if (after && !/^(?:if (?:not|so|you)\b|otherwise\b)/i.test(after)) return null;
  const plain = last.children.map((node) => prose(node, false)).join("");
  return plain
    .slice(end - wording.length, end)
    .replace(/\s+/g, " ")
    .trim();
}

export interface ApprovalQuestionReply {
  readonly thread: ScopedThreadRef;
  readonly runId: RunId;
  readonly messageId: MessageId;
  readonly question: string;
  readonly answer: "Yes" | "No";
}
