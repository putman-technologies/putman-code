import { describe, expect, it } from "vite-plus/test";
import { readApprovalQuestion } from "./approvalQuestion";

describe("conversational approval questions", () => {
  it("keeps the action and inline identifiers when an explanation follows", () => {
    expect(
      readApprovalQuestion(
        "Here’s the plan.\n\nNothing has changed. Do you approve creating the release account in `billing`? If not, deployments will keep using a personal account.",
      ),
    ).toBe("Do you approve creating the release account in billing?");
  });
  it("recognizes a formatted request", () => {
    expect(readApprovalQuestion("**Would you like me to proceed?**")).toBe(
      "Would you like me to proceed?",
    );
  });
  it.each([
    "The release was approved.",
    "What name should I use?",
    "Should I use staging or production?",
    "Should I deploy? Can I delete the old release?",
    "> Do you approve this change?",
    "Example: “Do you approve this change?”",
    "`May I proceed?`",
    "[Should I proceed?](https://example.com)",
    "```text\nDo you approve this change?\n```",
    "Should I proceed? I already did it.",
  ])("leaves ordinary chat alone for %s", (text) => {
    expect(readApprovalQuestion(text)).toBeNull();
  });
});
