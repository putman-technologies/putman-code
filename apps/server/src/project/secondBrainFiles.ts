// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeUtil from "node:util";
import { ChatAttachment } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  attachmentRelativePath,
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const hash = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
const documentName =
  /\.(?:pdf|docx?|xlsx?|pptx?|od[tps]|rtf|mdx?|txt|csv|tsv|html?|epub|ipynb|pages|numbers|png|jpe?g|gif|webp|svg|mp[34]|wav|mov|webm|zip)$/i;
const checkpointRef = /^refs\/t3\/orchestration-v2\/checkpoints\/[A-Za-z0-9_-]+\/ordinal\/\d+$/;
const parseAttachments = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(ChatAttachment)),
);
const parseChanges = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ path: Schema.String }))),
);
export interface BrainEntry {
  project_id: string;
  kind: string;
  source_id: string;
  thread_id: string;
  files_json: string;
  cwd: string | null;
  checkpoint_ref: string | null;
  parent_ref: string | null;
}
function safeName(name: string) {
  return (
    name
      .split(/[/\\]/)
      .at(-1)
      ?.replace(/[^\p{L}\p{N}. _-]/gu, "_")
      .slice(-120)
      .replace(/^[. ]+|[. ]+$/g, "") || "file"
  );
}
export function brainFilePath(stateDir: string, project: string, fileKey: string, name: string) {
  return NodePath.join(stateDir, "second-brain", hash(project), fileKey, "file-" + safeName(name));
}
export async function captureBrainFiles(
  entry: BrainEntry,
  directories: { stateDir: string; attachmentsDir: string },
  previousNames: ReadonlySet<string>,
  signal: AbortSignal,
  attachmentIds?: ReadonlySet<string>,
) {
  const copies: { name: string; fileKey: string }[] = [];
  let pending = false;
  async function save(name: string, identity: string, write: (tmp: string) => Promise<unknown>) {
    const fileKey = hash(JSON.stringify([entry.kind, entry.source_id, identity]));
    const destination = brainFilePath(directories.stateDir, entry.project_id, fileKey, name);
    const tmp = destination + "." + NodeCrypto.randomUUID() + ".part";
    try {
      const existing = await NodeFSP.stat(destination).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!existing?.isFile()) {
        await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true, mode: 0o700 });
        try {
          await write(tmp);
          await NodeFSP.rename(tmp, destination);
        } finally {
          await NodeFSP.rm(tmp, { force: true });
        }
      }
      copies.push({ name, fileKey });
    } catch (error) {
      if (signal.aborted) throw error;
      pending = true;
    }
  }
  if (entry.kind !== "checkpoint") {
    for (const attachment of parseAttachments(entry.files_json)) {
      if (attachment.type !== "file" && attachment.type !== "image") continue;
      if (attachmentIds && !attachmentIds.has(attachment.id)) continue;
      const relative = attachmentRelativePath(attachment);
      if (
        !relative ||
        parseThreadSegmentFromAttachmentId(attachment.id) !==
          toSafeThreadAttachmentSegment(entry.thread_id)
      )
        continue;
      await save(attachment.name, attachment.id, async (tmp) => {
        const source = NodePath.join(directories.attachmentsDir, relative);
        const file = await NodeFSP.open(
          source,
          NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
        );
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size !== attachment.sizeBytes)
            throw new Error("Incomplete attachment");
          await NodeStreamPromises.pipeline(
            file.createReadStream(),
            NodeFS.createWriteStream(tmp, { flags: "wx", mode: 0o600 }),
            { signal },
          );
        } finally {
          await file.close();
        }
      });
    }
    return { copies, pending };
  }
  const { cwd, checkpoint_ref: ref, parent_ref: base } = entry;
  const candidates = parseChanges(entry.files_json)
    .map(({ path: name }) => name)
    .filter((name) => documentName.test(name));
  if (
    !candidates.length ||
    !cwd ||
    !ref ||
    !checkpointRef.test(ref) ||
    !base ||
    !checkpointRef.test(base)
  )
    return { copies, pending };
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_NO_REPLACE_OBJECTS = "1";
  const git = async (args: string[]) =>
    (await exec("git", args, { cwd, env, signal, maxBuffer: 32 * 1024 * 1024 })).stdout;
  const added = new Set(
    (
      await git([
        "-c",
        "diff.relative=false",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--find-renames",
        "--name-only",
        "--diff-filter=A",
        "-z",
        base,
        ref,
        "--",
        ".",
      ])
    ).split("\0"),
  );
  const prefix = (await git(["rev-parse", "--show-prefix"])).replace(/\n$/, "");
  for (const name of candidates) {
    if (
      !name.startsWith(prefix) ||
      name.split("/").some((part) => part.startsWith(".") || !part) ||
      (!added.has(name) && !previousNames.has(name))
    )
      continue;
    const tree = await git([
      "--literal-pathspecs",
      "ls-tree",
      "-z",
      "--full-tree",
      ref,
      "--",
      name,
    ]);
    const match = /^100(?:644|755) blob ([a-f0-9]{40,64})\t([^\0]+)\0$/.exec(tree);
    if (!match || match[2] !== name) continue;
    const oid = match[1]!;
    await save(name, name, async (tmp) => {
      const child = NodeChildProcess.spawn("git", ["cat-file", "blob", oid], {
        cwd,
        env,
        signal,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const exited = new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) =>
          code === 0 ? resolve() : reject(new Error("Could not read the saved Git object.")),
        );
      });
      try {
        await Promise.all([
          exited,
          NodeStreamPromises.pipeline(
            child.stdout,
            NodeFS.createWriteStream(tmp, { flags: "wx", mode: 0o600 }),
            { signal },
          ),
        ]);
      } finally {
        if (child.exitCode === null) child.kill();
      }
    });
  }
  return { copies, pending };
}
