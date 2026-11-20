# PutmanCode project coordinator

Open a project’s release board to work with its plan, reviews, holds and queued workers. The Mac app and browser use the same board on the selected server.

## Team access and the project plan

Open the board once on each contributor’s paired device. From a local administrative desktop session or an administrative server pairing, expand **Project access and workers**, replace the device label with the person’s name and set Submit, Approve and Release independently. Use a separate pairing for each person. An ordinary paired contributor starts with Submit. A new pairing has a new identity. Older approvals without a named receipt require review again. Project roles govern the coordinator actions. Configure repository and production environment permissions for anyone with direct GitHub or shell access separately.

Use **Add task** to enter an owner, feature chat, acceptance criteria and dependencies. Open the linked feature chat directly from the task. Mark dependencies done to unblock the next task. Queued or running work locks edits to that task until it stops.

## Review and production

After a successful deployment is recorded in GitHub’s production environment, **What will ship?** compares that commit with the project’s current default-branch tip. The review includes changes from unselected PRs and direct commits. The server checks the selection, range, approvals and holds again on confirmation. An unavailable baseline, incomplete comparison or changed review prevents dispatch. An existing site needs an accurate successful GitHub deployment record for its running revision before its first managed release.

A releaser can hold the entire project with `*`, a pull request with `#42`, or a repository path such as `apps/payroll`. A path covers its descendants and both sides of a rename. A hold gates new coordinator release requests. Use the GitHub environment controls to stop an already-dispatched run. Configure the repository’s protected workflow from `docs/examples/putmancode-release.yml` and its staging and production adapters.

Failed CI shows the checks compared with the PR’s base. Automatic repair wakes the feature chat only when the failed checks have identifiable passing counterparts on the base. Startup failures, failing baseline checks, missing evidence and ambiguous results stay available for human review. A passing base can coexist with a flaky test on the feature branch.

## Private interactive previews

Install the review and preview workflow examples in the **managed project’s** `.github/workflows` directory on its default branch. Supply an executable `.github/putmancode/preview SHA OUTPUT_DIR` that builds a working static copy with synthetic records, a root `index.html` and assets that work under `/<sha>/`. Include acceptance steps in the PR using the existing PutmanCode review checklist. The example supports same-repository PRs. Its build job receives read-only repository access and synthetic fixtures. A separate publishing job uploads static assets.

Set these variables on the GitHub `private-preview` environment:

| Setting                       | Value                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------- |
| `PRIVATE_PREVIEW_ORIGIN`      | Dedicated authenticated HTTPS preview origin, also entered on the project board |
| `PRIVATE_PREVIEW_BUCKET`      | Private S3 bucket behind that origin, with public access blocked                |
| `PREVIEW_AWS_REGION`          | Region containing the bucket                                                    |
| `PREVIEW_ACCESS_LOGIN_ORIGIN` | Trusted sign-in origin when the preview gateway redirects visitors to sign in   |

Give the preview publishing role access only to this project’s preview bucket. The example reads environment secrets `PREVIEW_AWS_ACCESS_KEY_ID` and `PREVIEW_AWS_SECRET_ACCESS_KEY`. Gate the entire preview origin with your existing sign-in service, use a separate site from production, and apply a bucket lifecycle expiry. The workflow checks anonymous access before and after upload. For a backend-dependent app, supply a fixture API in the preview build. On **Review handoff**, select **Try this change**, follow the acceptance steps, then submit feedback with the screen or route. Feedback includes the exact commit. A native handoff returns to its feature chat, while a standalone submitted PR uses its project coordinator.

## Optional Linux VPS workers

Start a worker only for projects opted into the managed queue. Install Git, Python 3 and Docker on the VPS. Use a dedicated non-root account with Docker access, access to the PutmanCode server’s SQLite database and write access to the listed Git repositories. Use a project-dedicated provider API key in a private file. The worker reads its host-owned configuration from outside all managed repositories. For example:

```json
{
  "YOUR_PROJECT_ID": {
    "repository": "/srv/git/your-project",
    "agent_image": "registry.example.com/putmancode/agent@sha256:YOUR_DIGEST",
    "api_key_file": "/etc/putmancode/keys/your-project",
    "browser_image": "registry.example.com/putmancode/browser@sha256:YOUR_DIGEST",
    "browser_command": ["/opt/checks/run-fixture-tests", "/work"],
    "timeout_seconds": 900
  }
}
```

Copy the project ID from **Project access and workers**. The agent image needs a Claude Code executable named `claude` on its PATH with support for `--max-turns` and `--max-budget-usd`. The browser image should include the browser, test dependencies and a fixture test command that can run with the network disabled. Pull and pin both images by digest. Make the key file readable only by the worker account (mode 0600). Keep model credentials and live services out of the browser image and fixtures.

```sh
python3 scripts/putmancode-worker.py --db /path/to/putmancode/userdata/statev2.sqlite --config /etc/putmancode/workers.json
```

Use `--once` to process at most one eligible job. The server must have started with migration 102 first. A single supervisor per database runs several jobs, with project worker and browser limits checked transactionally. Each container receives a clean snapshot of the feature branch at claim time. Uncommitted files stay in the original checkout. The agent has editing tools and a project-specific model key. The browser has an offline test command. Only the workspace is mounted. Worker output appears as a local `putmancode-worker/…` Git branch for review. A subsequent run for that task uses the previous result branch. Push or merge reviewed changes through the normal feature handoff.

Each task receives its initial turn and USD allowances when created. The worker passes the remaining allocation to Claude Code, records reported usage, and reserves the full allocation after a run with unknown usage. Provider-reported charges can exceed a budget on the final call. An administrator can extend a specific task’s budget explicitly. These limits apply to managed plan jobs. Existing interactive chats and other provider sessions are billed through their own provider settings.
