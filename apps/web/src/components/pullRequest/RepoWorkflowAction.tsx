import type {
  EnvironmentId,
  PullRequestRef,
  RepoWorkflow,
  RepoWorkflowButtonRequest,
  RepoWorkflowButtonResult,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import { useGT } from "gt-react";
import { useImperativeHandle, useRef, useState, type Ref } from "react";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogPanel,
  DialogTitle,
  DialogFooter,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectTrigger, SelectPopup, SelectItem } from "../ui/select";
import { toastManager } from "../ui/toast";
import { readableFailure } from "./pullRequestDetail.logic";
import { readLocalApi } from "../../localApi";

const Config = Schema.NullOr(
  Schema.Struct({ label: Schema.String, id: Schema.Int, hasInputs: Schema.Boolean }),
);
type Catalog = Extract<RepoWorkflowButtonResult, { kind: "list" }>;
export interface RepoWorkflowActionHandle {
  configure(): void;
}

export function RepoWorkflowAction({
  ref,
  environmentId,
  reference,
  repositoryUrl,
  merged,
}: {
  ref: Ref<RepoWorkflowActionHandle>;
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  repositoryUrl: string;
  merged: boolean;
}) {
  const gt = useGT();
  const repositoryKey =
    new URL(repositoryUrl).host.toLowerCase() + "/" + reference.repository.toLowerCase();
  const [config, setConfig] = useLocalStorage(
    "putmancode:pr-workflow:" + repositoryKey,
    null,
    Config,
  );
  const execute = useAtomCommand(pullRequestEnvironment.workflowButton, { reportFailure: false });
  const [mode, setMode] = useState<"configure" | "run" | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [label, setLabel] = useState("");
  const [id, setId] = useState<number | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const selected = catalog?.workflows.find((w) => w.id === id);
  const request = async (action: RepoWorkflowButtonRequest) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    const result = await execute({
      environmentId,
      input: { ...reference, request: action },
    }).finally(() => {
      pending.current = false;
      setBusy(false);
    });
    if (result._tag === "Success") return result.value;
    const message = readableFailure(
      squashAtomCommandFailure(result),
      gt("Check your GitHub Actions access and try again."),
    );
    setError(message);
    if (action.kind === "run")
      toastManager.add({
        type: "error",
        title: gt("Workflow could not be started"),
        description: message,
      });
  };
  const open = async (next: "configure" | "run") => {
    if (pending.current) return;
    setMode(next);
    setCatalog(null);
    setValues({});
    setId(config?.id ?? null);
    setLabel(config?.label ?? gt("Deploy"));
    const reply = await request({ kind: "list" });
    if (reply?.kind !== "list") return;
    setCatalog(reply);
    const workflow = reply.workflows.find((w) => w.id === config?.id);
    if (next === "run" && !workflow)
      setError(
        gt("The saved workflow is unavailable. Choose another in Configure workflow button."),
      );
    if (workflow) setValues(initialInputs(workflow, reply.mergeSha));
  };
  useImperativeHandle(ref, () => ({
    configure: () => {
      void open("configure");
    },
  }));
  const dispatch = async (workflowId: number, inputs: Record<string, string>) => {
    const result = await request({ kind: "run", workflowId, inputs });
    if (result?.kind !== "dispatched") return;
    setMode(null);
    setValues({});
    toastManager.add({
      type: "success",
      title: gt("Workflow started on {branch}", { branch: result.base }),
      actionProps: {
        children: gt("Open workflow"),
        onClick: () => void readLocalApi()?.shell.openExternal(result.url),
      },
    });
  };
  return (
    <>
      {config && (
        <Button
          size="sm"
          variant="outline"
          disabled={!merged || busy}
          aria-label={config.label}
          onClick={() => {
            if (config.hasInputs) void open("run");
            else void dispatch(config.id, {});
          }}
        >
          {config.label}
        </Button>
      )}
      <Dialog
        open={mode !== null}
        onOpenChange={(v) => {
          if (!v && !busy) {
            setMode(null);
            setValues({});
          }
        }}
      >
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {mode === "configure" ? gt("Configure workflow button") : config?.label}
            </DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-3">
              {mode === "configure" && (
                <>
                  <label className="grid gap-1 text-sm">
                    {gt("Button label")}
                    <Input
                      value={label}
                      maxLength={32}
                      onChange={(e) => setLabel(e.target.value)}
                    />
                  </label>
                  <div className="grid gap-1 text-sm">
                    <span>{gt("GitHub workflow")}</span>
                    <Select
                      modal={false}
                      value={String(id ?? "")}
                      onValueChange={(v) => setId(Number(v))}
                    >
                      <SelectTrigger aria-label={gt("GitHub workflow")}>
                        {selected?.name ?? gt("Choose a workflow")}
                      </SelectTrigger>
                      <SelectPopup>
                        {catalog?.workflows.map((w) => (
                          <SelectItem key={w.id} value={String(w.id)}>
                            {w.name} · {w.file}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </div>
                  {catalog && catalog.workflows.length === 0 && (
                    <p className="text-sm text-muted-foreground">
                      {gt("This branch has no active workflows with a workflow_dispatch trigger.")}
                    </p>
                  )}
                </>
              )}
              {busy && !catalog && <p role="status">{gt("Loading workflows…")}</p>}
              {catalog && (
                <p className="text-sm text-muted-foreground">
                  {gt("Runs on the latest commit of {branch} after merge.", {
                    branch: catalog.base,
                  })}
                </p>
              )}
              {mode === "run" &&
                selected?.fields.map((f) => {
                  const change = (value: string) =>
                    setValues((previous) => ({ ...previous, [f.name]: value }));
                  return (
                    <div key={f.name} className="grid gap-1 text-sm">
                      <span>
                        {f.name}
                        {f.required ? " *" : ""}
                      </span>
                      {f.description && (
                        <span className="text-xs text-muted-foreground">{f.description}</span>
                      )}
                      {f.type === "choice" || f.type === "boolean" ? (
                        <Select
                          modal={false}
                          value={values[f.name] ?? ""}
                          onValueChange={(v) => change(String(v ?? ""))}
                        >
                          <SelectTrigger aria-label={f.name}>
                            {values[f.name] || gt("Choose an option")}
                          </SelectTrigger>
                          <SelectPopup>
                            {(f.type === "boolean" ? ["true", "false"] : f.options).map((value) => (
                              <SelectItem key={value} value={value}>
                                {value}
                              </SelectItem>
                            ))}
                          </SelectPopup>
                        </Select>
                      ) : (
                        <Input
                          aria-label={f.name}
                          type={f.type === "number" ? "number" : "text"}
                          value={values[f.name] ?? ""}
                          onChange={(e) => change(e.target.value)}
                        />
                      )}
                    </div>
                  );
                })}
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
            </div>
          </DialogPanel>
          <DialogFooter>
            {mode === "configure" ? (
              <>
                {config && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setConfig(null);
                      setMode(null);
                    }}
                  >
                    {gt("Remove button")}
                  </Button>
                )}
                <Button
                  disabled={busy || !selected || !label.trim()}
                  onClick={() => {
                    if (selected) {
                      setConfig({
                        label: label.trim(),
                        id: selected.id,
                        hasInputs: selected.fields.length > 0,
                      });
                      setMode(null);
                    }
                  }}
                >
                  {gt("Save")}
                </Button>
              </>
            ) : (
              <Button
                disabled={
                  busy ||
                  !merged ||
                  !selected ||
                  selected.fields.some((f) => f.required && !values[f.name]?.trim())
                }
                onClick={() => {
                  if (selected)
                    void dispatch(
                      selected.id,
                      Object.fromEntries(
                        Object.entries(values).filter(([, value]) => value !== ""),
                      ),
                    );
                }}
              >
                {gt("Run workflow")}
              </Button>
            )}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}

function initialInputs(workflow: RepoWorkflow, mergeSha: string | null) {
  return Object.fromEntries(
    workflow.fields.map((f) => [
      f.name,
      f.defaultValue ??
        (f.name === "source_sha" && mergeSha
          ? mergeSha
          : f.type === "boolean"
            ? "false"
            : f.type === "choice"
              ? (f.options[0] ?? "")
              : ""),
    ]),
  );
}
