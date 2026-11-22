import { AssistantHost, type AssistantAction, type AssistantState } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { T, useGT } from "gt-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { randomUUID } from "../../lib/utils";
import ReactMarkdown, { type Components } from "react-markdown";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

const assistantMarkdown: Components = {
  img: () => null,
  a: ({ href, children }) =>
    /^https?:\/\//i.test(href ?? "") ? (
      <a className="text-primary underline" href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
};
const isAssistantHost = Schema.is(AssistantHost);
const hostKey = "putmancode:personal-assistant:ssh-host";
type Request = (host: string, action: AssistantAction) => Promise<AssistantState>;
const request: Request = async (host, action) => {
  if (!window.desktopBridge?.personalAssistant)
    throw new Error("Update the PutmanCode desktop app.");
  return window.desktopBridge.personalAssistant({ host, action });
};

function errorText(error: unknown) {
  return String(error instanceof Error ? error.message : error).replace(
    /^Error invoking remote method '[^']+': (?:Error: )?/,
    "",
  );
}

export default function AssistantDialog({
  onClose,
  call = request,
}: {
  onClose: () => void;
  call?: Request;
}) {
  const gt = useGT();
  const [host, setHost] = useLocalStorage(hostKey, "", Schema.String);
  const [address, setAddress] = useState(host);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [initial, setInitial] = useState<AssistantState>();
  const [hosts, setHosts] = useState<readonly string[]>([]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- offer SSH aliases from this computer during setup.
  useEffect(() => {
    if (!host)
      void window.desktopBridge
        ?.discoverSshHosts?.()
        .then((items) => setHosts(items.map((item) => item.alias)))
        .catch(() => {});
  }, [host]);

  async function connect() {
    if (busy || !isAssistantHost(address.trim())) return;
    setBusy(true);
    setFailure("");
    try {
      const result = await call(address.trim(), { kind: "connect" });
      setInitial(result);
      setHost(address.trim());
    } catch (error) {
      setFailure(errorText(error));
    }
    setBusy(false);
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            <T>Personal assistant</T>
          </DialogTitle>
        </DialogHeader>
        {host ? (
          <Conversation
            key={host}
            host={host}
            initial={initial}
            call={call}
            onChangeHost={() => {
              setAddress(host);
              setInitial(undefined);
              setHost("");
            }}
          />
        ) : (
          <DialogPanel>
            <form
              className="grid gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void connect();
              }}
            >
              <p className="text-sm text-muted-foreground">
                <T>
                  Connect a personal Linux SSH account to keep your conversation and run tasks while
                  your desktop is closed.
                </T>
              </p>
              <label className="grid gap-1 text-sm">
                {gt("SSH host or alias")}
                <Input
                  value={address}
                  list="personal-assistant-hosts"
                  placeholder="user@host"
                  autoComplete="off"
                  onChange={(e) => setAddress(e.target.value)}
                />
                <datalist id="personal-assistant-hosts">
                  {hosts.map((item) => (
                    <option key={item} value={item} />
                  ))}
                </datalist>
              </label>
              <Button type="submit" disabled={busy || !isAssistantHost(address.trim())}>
                {busy ? gt("Connecting…") : gt("Connect and install worker")}
              </Button>
              {failure && (
                <p role="alert" className="text-sm text-destructive">
                  {failure}
                </p>
              )}
            </form>
          </DialogPanel>
        )}
      </DialogPopup>
    </Dialog>
  );
}

function Conversation({
  host,
  initial,
  call,
  onChangeHost,
}: {
  host: string;
  initial?: AssistantState | undefined;
  call: Request;
  onChangeHost: () => void;
}) {
  const gt = useGT();
  const [state, setState] = useState(initial);
  const [draft, setDraft] = useState("");
  const [notify, setNotify] = useState(false);
  const [phoneSetup, setPhoneSetup] = useState(false);
  const [keys, setKeys] = useState({ userKey: "", token: "" });
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const [busy, setBusy] = useState(false);
  const [before, setBefore] = useState<number>();
  const requestId = useRef(randomUUID());
  const revision = useRef(0);
  const timeline = useRef<HTMLDivElement>(null);
  const followEnd = useRef(true);
  const last = state?.tasks.at(-1);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keep the scroll position at the newest response while the reader is following it.
  useLayoutEffect(() => {
    if (last && followEnd.current && timeline.current)
      timeline.current.scrollTop = timeline.current.scrollHeight;
  }, [last]);
  const statusLabels = {
    queued: gt("Queued"),
    running: gt("Running"),
    done: gt("Completed"),
    needs_input: gt("Needs your answer"),
    failed: gt("Failed"),
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- read the VPS queue while this conversation is open.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const start = revision.current;
      let delay = 15000;
      try {
        const result = await call(
          host,
          before === undefined ? { kind: "state" } : { kind: "state", before },
        );
        if (!stopped && start === revision.current) {
          setState(result);
          setPollError("");
        }
        if (
          result.tasks.some(
            (item) =>
              item.status === "running" || item.status === "queued" || item.delivery === "pending",
          )
        )
          delay = 3500;
      } catch (err) {
        if (!stopped && start === revision.current) setPollError(errorText(err));
      }
      if (!stopped) timer = setTimeout(() => void poll(), delay);
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [call, host, before]);

  async function act(action: AssistantAction) {
    if (busy) return;
    setBusy(true);
    setError("");
    revision.current++;
    try {
      const result = await call(host, action);
      revision.current++;
      setState(result);
      setPollError("");
      setBefore(undefined);
      if (action.kind === "send") {
        setDraft("");
        setNotify(false);
        requestId.current = randomUUID();
      }
      if (action.kind === "phone" || action.kind === "forgetPhone") {
        setPhoneSetup(false);
        setKeys({ userKey: "", token: "" });
        setNotify(false);
      }
    } catch (err) {
      setError(errorText(err));
    }
    setBusy(false);
  }

  return (
    <DialogPanel>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="mr-auto truncate font-mono text-muted-foreground">{host}</span>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onChangeHost}>
          {gt("Change server")}
        </Button>
        {state && (
          <Button
            size="sm"
            variant="outline"
            aria-expanded={phoneSetup}
            onClick={() => setPhoneSetup(!phoneSetup)}
          >
            {gt("Android notifications")}
          </Button>
        )}
      </div>
      {phoneSetup && (
        <form
          className="grid gap-2 rounded-lg border p-3 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            void act({ kind: "phone", ...keys });
          }}
        >
          <p>
            <T>
              Install Pushover on Android. Enter your user key and application token to send a test
              alert.
            </T>
          </p>
          <div className="flex gap-4 text-primary underline">
            <a href="https://pushover.net/clients/android" target="_blank" rel="noreferrer">
              <T>Pushover</T>
            </a>
            <a href="https://pushover.net/apps/build" target="_blank" rel="noreferrer">
              {gt("Create application token")}
            </a>
          </div>
          <Input
            type="password"
            autoComplete="off"
            placeholder={gt("Pushover user key")}
            aria-label={gt("Pushover user key")}
            value={keys.userKey}
            onChange={(e) => setKeys({ ...keys, userKey: e.target.value.trim() })}
          />
          <Input
            type="password"
            autoComplete="off"
            placeholder={gt("Application token")}
            aria-label={gt("Application token")}
            value={keys.token}
            onChange={(e) => setKeys({ ...keys, token: e.target.value.trim() })}
          />
          <div className="flex gap-2">
            <Button
              type="submit"
              size="sm"
              disabled={
                busy || ![keys.token, keys.userKey].every((key) => /^[a-zA-Z0-9]{30}$/.test(key))
              }
            >
              {gt("Send test and save")}
            </Button>
            {state?.phone && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void act({ kind: "forgetPhone" })}
              >
                {gt("Disconnect phone")}
              </Button>
            )}
          </div>
        </form>
      )}
      {(pollError || error) && (
        <p role="alert" className="break-words text-sm text-destructive">
          {error || pollError}
        </p>
      )}
      {state && !state.alwaysOn && (
        <p role="status" className="text-sm text-muted-foreground">
          {gt("To keep tasks running after SSH logout, enable lingering for this Linux account.")}{" "}
          <code>loginctl enable-linger</code>
        </p>
      )}
      {state && !state.running && (
        <Button variant="outline" disabled={busy} onClick={() => void act({ kind: "connect" })}>
          {gt("Restart worker")}
        </Button>
      )}
      {!state && !pollError && <p role="status">{gt("Connecting…")}</p>}
      {state && (
        <>
          <div className="flex gap-3">
            {state.older && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setBefore(state.tasks[0]?.seq)}
              >
                {gt("Older messages")}
              </Button>
            )}
            {before !== undefined && (
              <Button size="sm" variant="ghost" onClick={() => setBefore(undefined)}>
                {gt("Latest messages")}
              </Button>
            )}
          </div>
          <div
            ref={timeline}
            onScroll={(event) => {
              const el = event.currentTarget;
              followEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            }}
            className="max-h-[42vh] space-y-3 overflow-y-auto"
            aria-label={gt("Conversation")}
          >
            {state.tasks.map((item) => (
              <article key={item.id} className="grid gap-2 text-sm">
                <p className="ml-8 justify-self-end whitespace-pre-wrap wrap-anywhere rounded-lg bg-secondary px-3 py-2">
                  {item.prompt}
                </p>
                <span className="font-semibold text-muted-foreground">
                  {statusLabels[item.status]}
                </span>
                {item.answer && (
                  <div className="space-y-2 wrap-anywhere leading-relaxed [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5">
                    <ReactMarkdown skipHtml components={assistantMarkdown}>
                      {item.answer}
                    </ReactMarkdown>
                  </div>
                )}
                {item.delivery === "sent" && <small>{gt("Phone alert sent")}</small>}
                {(item.delivery === "failed" || item.delivery === "unknown") && (
                  <small role="status">
                    {gt("Phone alert unconfirmed. Check Android notifications.")}
                  </small>
                )}
              </article>
            ))}
          </div>
          {before === undefined && (
            <form
              className="grid gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (draft.trim())
                  void act({
                    kind: "send",
                    id: requestId.current,
                    prompt: draft.trim(),
                    notify: notify && state.phone,
                  });
              }}
            >
              <Textarea
                value={draft}
                rows={3}
                disabled={busy}
                maxLength={16000}
                aria-label={gt("Message")}
                placeholder={gt("Ask your assistant, or paste rows from your tracker…")}
                onChange={(e) => {
                  setDraft(e.target.value);
                  requestId.current = randomUUID();
                }}
              />
              <div className="flex items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={notify && state.phone}
                    disabled={!state.phone || busy}
                    onChange={(e) => setNotify(e.target.checked)}
                  />
                  {gt("Notify me when done")}
                </label>
                <Button type="submit" disabled={busy || !state.running || !draft.trim()}>
                  {gt("Send")}
                </Button>
              </div>
            </form>
          )}
        </>
      )}
    </DialogPanel>
  );
}
