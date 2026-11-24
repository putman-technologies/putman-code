import { unsetInheritedGitRepositoryEnv } from "./gitRepositoryEnv.ts";

// A test run started from `git bisect run`, `git rebase --exec` or a hook inherits GIT_DIR. Every git
// command a test or the code under test starts would then write into that repository.
// oxlint-disable-next-line t3code/no-global-process-runtime -- This shared test bootstrap runs before either Node or jsdom loads services. Importing HostProcess here pulls node:sea into the mobile UI test bundle.
for (const name of Object.keys(unsetInheritedGitRepositoryEnv(process.env, process.platform))) {
  delete process.env[name];
}
