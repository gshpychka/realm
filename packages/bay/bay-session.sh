# Session operations inside the guest, run as root. SESSION_USER is the user programs run as, SESSION_HOME its home
# directory and WORK the directory programs start in and repos are cloned under.

usage() {
  cat >&2 <<'EOF'
usage: bay-session ready
       bay-session launch quiet|monitor -- [COMMAND...]
       bay-session program
       bay-session attach
       bay-session operator --record ID --generation GENERATION OPERATION KEY
       bay-session stop
       bay-session save-history -- PATH...
       bay-session restore-history
       bay-session deliver-repo OWNER/NAME COMMIT REMOTE [BRANCH]
EOF
  exit 2
}

# as_user runs a command as the session user with the environment of a fresh login.
as_user() {
  runuser -u "$SESSION_USER" -- env -i \
    HOME="$SESSION_HOME" USER="$SESSION_USER" LOGNAME="$SESSION_USER" \
    PATH="/run/wrappers/bin:/etc/profiles/per-user/$SESSION_USER/bin:/run/current-system/sw/bin" \
    TERM="${TERM:-xterm-256color}" LANG=C.UTF-8 \
    "$@"
}

# The session's tmux server runs as root, so the program, which runs as the session user, cannot reconfigure what
# reaches the operator's terminal. The program's pane carries @bay-program, and tmux keeps it after the program exits.
program_running() {
  [ "$(tmux list-panes -a -f '#{@bay-program}' -F '#{pane_dead}' 2>/dev/null)" = 0 ]
}

[ $# -ge 1 ] || usage
operation=$1
shift

case "$operation" in
ready)
  # a failed unit leaves the guest degraded, which still counts as booted
  state=$(systemctl is-system-running --wait || true)
  case "$state" in
  running | degraded) ;;
  *)
    echo "guest is $state" >&2
    exit 1
    ;;
  esac
  ;;

launch)
  [ $# -ge 2 ] && [ "$2" = -- ] || usage
  mode=$1
  shift 2
  [ $# -gt 0 ] || set -- bash -l
  tmux kill-session -t main 2>/dev/null || true
  # a login shell gives the program the system profile's environment
  # setpriv execs the program in place, so the program itself holds the pane and gets its hangup
  pane=$(tmux new-session -d -P -F '#{pane_id}' -s main -x 200 -y 50 -c "$WORK" -- \
    setpriv --reuid="$SESSION_USER" --regid="$(id -g "$SESSION_USER")" --init-groups -- \
    env -i HOME="$SESSION_HOME" USER="$SESSION_USER" LOGNAME="$SESSION_USER" \
    PATH="/run/wrappers/bin:/etc/profiles/per-user/$SESSION_USER/bin:/run/current-system/sw/bin" \
    TERM=tmux-256color LANG=C.UTF-8 bash -lc 'exec "$@"' program "$@")
  tmux set-option -p -t "$pane" @bay-program 1
  if [ "$mode" = monitor ]; then
    tmux set-option -w -t "$pane" monitor-bell on \; set-option -w -t "$pane" monitor-silence 600
  fi
  ;;

program)
  if program_running; then
    echo running
  else
    echo stopped
  fi
  ;;

attach)
  if ! program_running; then
    echo "the program is not running; bay resume $(</proc/sys/kernel/hostname) starts it again" >&2
    exit 1
  fi
  exec env TERM="${TERM:-xterm-256color}" tmux attach -t main
  ;;


operator)
  # This fixed helper owns root-protected receipts and immutable bytes. Its requested commands drop to SESSION_USER.
  exec "$BAY_GUEST" --user "$SESSION_USER" --home "$SESSION_HOME" --work "$WORK" "$@"
  ;;

stop)
  # each pane's process leads a session of its own, which holds the program and everything it started;
  # kill-server returns before they have exited
  sessions=$(tmux list-panes -a -f '#{==:#{pane_dead},0}' -F '#{pane_pid}' 2>/dev/null | paste -sd, -) || true
  tmux kill-server 2>/dev/null || true
  if [ -n "$sessions" ]; then
    timeout 10 "$BASH" -c 'while pgrep -s "$@" >/dev/null; do sleep 0.1; done' _ "$sessions" ||
      pkill -KILL -s "$sessions" || true
  fi
  ;;

save-history)
  [ "${1:-}" = -- ] || usage
  shift
  present=()
  for path in "$@"; do
    if [ -e "$SESSION_HOME/$path" ]; then
      present+=("$path")
    fi
  done
  if [ ${#present[@]} -gt 0 ]; then
    as_user tar -C "$SESSION_HOME" -cf - --sparse -- "${present[@]}"
  fi
  ;;

restore-history)
  as_user tar -C "$SESSION_HOME" -xf -
  ;;

deliver-repo)
  [ $# -ge 3 ] || usage
  repo=$1 commit=$2 remote=$3 branch=${4:-}
  dest="$WORK/$repo"
  mirror=$(mktemp -d)
  trap 'rm -rf "$mirror"' EXIT
  tar -C "$mirror" -xf -
  chown -R "$SESSION_USER" "$mirror"
  as_user mkdir -p "$(dirname "$dest")"
  as_user git clone --quiet --no-checkout "$mirror" "$dest"
  as_user git -C "$dest" remote set-url origin "$remote"
  if [ -n "$branch" ]; then
    as_user git -C "$dest" checkout --quiet -B "$branch" "$commit"
    # the branch may be gone from the remote since the session first started
    if as_user git -C "$dest" rev-parse --verify --quiet "origin/$branch" >/dev/null; then
      as_user git -C "$dest" branch --quiet --set-upstream-to="origin/$branch" "$branch"
    fi
  else
    as_user git -C "$dest" checkout --quiet --detach "$commit"
  fi
  ;;

*)
  usage
  ;;
esac
