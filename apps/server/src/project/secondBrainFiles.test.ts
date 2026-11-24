// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it, expect } from "vite-plus/test";
import { brainFilePath, captureBrainFiles } from "./secondBrainFiles.ts";

it("copies generated document bytes from the recorded revision and keeps existing documents, code and other projects as references", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "putman-brain-git-"));
  try {
    const cwd = NodePath.join(root, "repo");
    await NodeFSP.mkdir(cwd);
    const git = (...args: string[]) =>
      NodeChildProcess.execFileSync(
        "git",
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@localhost",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        { cwd, stdio: "pipe" },
      );
    git("init", "-q");
    await NodeFSP.writeFile(NodePath.join(cwd, "existing.pdf"), "existing");
    await NodeFSP.writeFile(NodePath.join(cwd, "original.txt"), "existing renamed document");
    git("add", ".");
    git("commit", "-qm", "base");
    const prefix = "refs/t3/orchestration-v2/checkpoints/test/ordinal/";
    git("update-ref", prefix + "0", "HEAD");
    git("mv", "original.txt", "moved.txt");
    const original = Buffer.from([0, 255, 1, 2]);
    await NodeFSP.writeFile(NodePath.join(cwd, "report.pdf"), original);
    await NodeFSP.writeFile(NodePath.join(cwd, "existing.pdf"), "edit");
    await NodeFSP.writeFile(NodePath.join(cwd, "code.ts"), "code");
    git("add", ".");
    git("commit", "-qm", "result");
    git("update-ref", prefix + "1", "HEAD");
    await NodeFSP.writeFile(NodePath.join(cwd, "report.pdf"), "later contents");
    const files = ["existing.pdf", "code.ts", "report.pdf", "moved.txt"].map((path) => ({ path }));
    const config = { stateDir: root, attachmentsDir: root };
    const { copies, pending } = await captureBrainFiles(
      {
        project_id: "chosen",
        kind: "checkpoint",
        thread_id: "t",
        source_id: "event",
        cwd,
        checkpoint_ref: prefix + "1",
        parent_ref: prefix + "0",
        files_json: JSON.stringify(files),
      },
      config,
      new Set(),
      new AbortController().signal,
    );
    expect(pending).toBe(false);
    expect(copies.map((copy) => copy.name)).toEqual(["report.pdf"]);
    const copy = copies[0]!;
    expect(await NodeFSP.readFile(brainFilePath(root, "chosen", copy.fileKey, copy.name))).toEqual(
      original,
    );
    expect(brainFilePath(root, "chosen", copy.fileKey, copy.name)).not.toEqual(
      brainFilePath(root, "other", copy.fileKey, copy.name),
    );
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
