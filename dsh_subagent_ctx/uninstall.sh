#!/usr/bin/env bash
set -euo pipefail
PROFILE="${DSH_PROFILE:-web}"
command -v dsh >/dev/null 2>&1 || { echo "ERROR: missing command: dsh" >&2; exit 1; }
dsh plugin --profile "$PROFILE" remove dsh-subagent-ctx
echo "removed dsh-subagent-ctx from profile '$PROFILE'; restart dsh to apply."
