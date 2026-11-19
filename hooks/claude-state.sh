#!/bin/sh
# Optional Claude Code hook for the terminal-groups extension (experiment).
# Writes the session's state to ~/.cache/terminal-groups/claude/<session_id>.json
# with the process ancestry, so the extension can match it to a terminal.
# Usage in ~/.claude/settings.json hooks: claude-state.sh <working|needs|end>
state="$1"
input=$(cat)
sid=$(printf '%s' "$input" | sed -n 's/.*"session_id" *: *"\([^"]*\)".*/\1/p' | head -1)
[ -z "$sid" ] && exit 0
dir="$HOME/.cache/terminal-groups/claude"
mkdir -p "$dir"
if [ "$state" = "end" ]; then
  rm -f "$dir/$sid.json"
  exit 0
fi
# Ancestor PIDs, starting at the claude process (our parent).
pids=""
p=$PPID
while [ -n "$p" ] && [ "$p" -gt 1 ]; do
  pids="$pids${pids:+,}$p"
  p=$(ps -o ppid= -p "$p" | tr -d ' ')
done
printf '{"state":"%s","claude_pid":%s,"pids":[%s],"ts":%s}\n' "$state" "$PPID" "$pids" "$(date +%s)" > "$dir/$sid.json.tmp" \
  && mv "$dir/$sid.json.tmp" "$dir/$sid.json"
exit 0
