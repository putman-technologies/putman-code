import { WS_METHODS } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import {
  acknowledgeRpcRequest,
  subscribeSlowRpcAckRequests,
  trackRpcRequestSent,
  type SlowRpcAckRequest,
} from "./requestLatencyState";

it("keeps simultaneous branch and file lookups out of the slow warning while tracking other requests", async () => {
  vi.useFakeTimers();
  let visible: ReadonlyArray<SlowRpcAckRequest> = [];
  const unsubscribe = subscribeSlowRpcAckRequests((requests) => {
    visible = requests;
  });
  try {
    trackRpcRequestSent("branch-1", WS_METHODS.vcsListRefs);
    trackRpcRequestSent("branch-2", WS_METHODS.vcsListRefs);
    trackRpcRequestSent("wake", WS_METHODS.vcsRefreshBranch);
    trackRpcRequestSent("files", WS_METHODS.projectsSearchEntries);
    trackRpcRequestSent("config", WS_METHODS.serverGetConfig);
    await vi.advanceTimersByTimeAsync(15_001);
    expect(visible.map((request) => request.requestId)).toEqual(["config"]);
    acknowledgeRpcRequest("config");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(visible).toEqual([]);
  } finally {
    for (const id of ["branch-1", "branch-2", "wake", "files", "config"]) acknowledgeRpcRequest(id);
    unsubscribe();
    vi.useRealTimers();
  }
});
