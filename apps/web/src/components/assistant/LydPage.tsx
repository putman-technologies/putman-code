import { suggestedAssistantHost } from "../../account/profileSync";
import { AssistantHost, type AssistantAction, type AssistantState } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { T, useGT } from "gt-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { randomUUID } from "../../lib/utils";
import ReactMarkdown, { type Components } from "react-markdown";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { Button } from "../ui/button";
import { ArrowUpIcon, BellIcon, ServerIcon } from "lucide-react";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import "./lyd.css";
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

function LydOrb({ small = false }: { small?: boolean }) {
  return <span aria-hidden="true" className={small ? "lyd-orb lyd-orb-small" : "lyd-orb"} />;
}

export default function LydPage({ call = request }: { call?: Request }) {
  const gt = useGT();
  const [host, setHost] = useLocalStorage(hostKey, "", Schema.String);
  const [address, setAddress] = useState(() => host || suggestedAssistantHost());
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
    <SidebarInset className="h-dvh min-w-0 overflow-hidden" aria-label="Lyd">
      <WorkspacePageHeader electron className="border-b border-border/60">
        <LydOrb small />
        <h1 className="text-sm font-semibold tracking-tight">Lyd</h1>
      </WorkspacePageHeader>
      <div className="lyd-workspace flex min-h-0 flex-1 flex-col">
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
          <div className="flex min-h-0 flex-1 flex-col items-center justify-safe-center overflow-y-auto px-5 py-10">
            <div className="mb-7 flex flex-col items-center gap-4">
              <LydOrb />
              <h2 className="text-3xl font-medium tracking-tight">{gt("Connect Lyd")}</h2>
            </div>
            <form
              className="grid w-full max-w-sm gap-4 rounded-3xl border border-border bg-card p-6 shadow-sm"
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
          </div>
        )}
      </div>
    </SidebarInset>
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
  const composer = useRef<HTMLTextAreaElement>(null);
  const [notify, setNotify] = useState(false);
  const [phoneSetup, setPhoneSetup] = useState(false);
  const [keys, setKeys] = useState({ userKey: "", token: "" });
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const [busy, setBusy] = useState(false);
  const [before, setBefore] = useState<number>();
  const requestId = useRef("");
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
        requestId.current = "";
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
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2 text-xs sm:px-6">
        <ServerIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
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
          className="mx-auto grid max-h-[42%] w-[min(30rem,95%)] shrink-0 gap-2 overflow-y-auto rounded-2xl border bg-card p-4 text-sm shadow-sm"
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
        <p
          role="alert"
          className="mx-auto w-full max-w-3xl px-6 py-1 break-words text-sm text-destructive"
        >
          {error || pollError}
        </p>
      )}
      {state && !state.alwaysOn && (
        <p role="status" className="px-5 text-center text-xs text-muted-foreground">
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
          <div className="mx-auto flex w-full max-w-3xl justify-center gap-3">
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
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
            aria-label={gt("Conversation")}
          >
            {state.tasks.length === 0 && before === undefined && (
              <div className="mx-auto flex min-h-full max-w-2xl flex-col items-center justify-center gap-5 px-5 py-8 text-center">
                <LydOrb />
                <h2 className="text-3xl font-medium tracking-tight sm:text-5xl">
                  {gt("What’s on your mind?")}
                </h2>
                <div className="mt-1 flex flex-wrap justify-center gap-2">
                  {(
                    [
                      [gt("Plan my day"), gt("Help me plan my day. Ask me what is on my list.")],
                      [
                        gt("Research a role"),
                        gt("Help me research a job opportunity. Ask me for the role and company."),
                      ],
                      [
                        gt("Review a tracker"),
                        gt("Help me review my tracker. I’ll paste the rows below."),
                      ],
                    ] as const
                  ).map(([label, prompt]) => (
                    <button
                      key={label}
                      type="button"
                      disabled={busy}
                      className="lyd-suggestion"
                      onClick={() => {
                        setDraft(prompt);
                        requestId.current = "";
                        composer.current?.focus();
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="mx-auto grid w-full max-w-3xl gap-8 px-5 sm:px-8">
              {state.tasks.map((item) => (
                <article key={item.id} className="grid gap-2 py-2 text-sm">
                  <p className="ml-8 justify-self-end whitespace-pre-wrap wrap-anywhere max-w-[88%] rounded-2xl rounded-br-sm bg-secondary px-4 py-3">
                    {item.prompt}
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <LydOrb small />
                    <strong className="font-medium">Lyd</strong>
                    <span className="text-xs text-muted-foreground">
                      {statusLabels[item.status]}
                    </span>
                  </div>
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
          </div>
          {before === undefined && (
            <form
              className="lyd-composer mx-auto mb-4 grid w-[min(44rem,calc(100%-2rem))] shrink-0 gap-2 rounded-3xl border border-border bg-card p-3 sm:mb-7"
              onSubmit={(e) => {
                e.preventDefault();
                if (!draft.trim()) return;
                if (!requestId.current) requestId.current = randomUUID();
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
                unstyled
                ref={composer}
                className="min-h-12 max-h-36 resize-none px-2 py-2 text-base"
                rows={2}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    if (!busy && state.running && draft.trim())
                      event.currentTarget.form?.requestSubmit();
                  }
                }}
                disabled={busy}
                maxLength={16000}
                aria-label={gt("Message")}
                placeholder={gt("Message Lyd…")}
                onChange={(e) => {
                  setDraft(e.target.value);
                  requestId.current = "";
                }}
              />
              <div className="flex items-center justify-between gap-2">
                <label className="flex items-center gap-2 px-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={notify && state.phone}
                    disabled={!state.phone || busy}
                    onChange={(e) => setNotify(e.target.checked)}
                  />
                  <BellIcon className="size-3.5" aria-hidden="true" />
                  {gt("Notify me when done")}
                </label>
                <Button
                  type="submit"
                  aria-label={gt("Send")}
                  className="size-9 rounded-full p-0"
                  disabled={busy || !state.running || !draft.trim()}
                >
                  <ArrowUpIcon aria-hidden="true" className="size-4" />
                </Button>
              </div>
            </form>
          )}
        </>
      )}
    </div>
  );
}
