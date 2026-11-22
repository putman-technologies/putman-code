#!/usr/bin/env bash
# Runs only on GitHub's disposable Linux VM; exercise the installed user service across client exits.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted ]]
name=putmancode-ci
sudo useradd --create-home "$name"
uid=$(id -u "$name")
account_home=$(getent passwd "$name" | cut -d: -f6)
sudo loginctl enable-linger "$name"
sudo systemctl start "user@$uid.service"
as_user=(sudo -u "$name" env "HOME=$account_home" "XDG_RUNTIME_DIR=/run/user/$uid" "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus")
worker="$account_home/.local/share/putmancode-assistant/worker.py"
"${as_user[@]}" mkdir -p -m 700 "$account_home/.local/bin" "$(dirname "$worker")"
sudo install -o "$name" -g "$name" -m 600 apps/desktop/resources/assistant/worker.py "$worker"
"${as_user[@]}" tee "$account_home/.local/bin/codex" >/dev/null <<'PY'
#!/usr/bin/python3
import json, pathlib, sys
if sys.argv[1:] == ["login", "status"]:
    sys.exit(0)
assert sys.argv[1] == "exec"
assert 'features.shell_tool=false' in sys.argv
assert "Closed client" in sys.stdin.read()
pathlib.Path(sys.argv[sys.argv.index("--output-last-message") + 1]).write_text(json.dumps({"status":"done","answer":"Finished on the VPS"}))
PY
"${as_user[@]}" chmod 700 "$account_home/.local/bin/codex"
request() { "${as_user[@]}" /usr/bin/python3 "$worker" request; }
printf '%s\n' '{"kind":"connect"}' | request | jq -e '.running and .alwaysOn'
printf '%s\n' '{"kind":"send","id":"5467e35d-5cea-4602-a06c-228ad4514cfd","prompt":"Closed client","notify":false}' | request | jq -e '.tasks | length == 1'
for _ in {1..30}; do
  state=$(printf '%s\n' '{"kind":"state"}' | request)
  if jq -e '.tasks[0].status == "done" and .tasks[0].answer == "Finished on the VPS" and .tasks[0].delivery == "off"' <<< "$state"; then
    "${as_user[@]}" systemctl --user restart putmancode-assistant.service
    printf '%s\n' '{"kind":"state"}' | request | jq -e '.running and .tasks[0].status == "done"'
    exit 0
  fi
  sleep 1
done
printf '%s\n' "$state" >&2
exit 1
