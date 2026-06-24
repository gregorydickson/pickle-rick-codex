## Trap Doors

- `detached-launch.js` — INVARIANT: fresh `.tmux-launch.lock` and cwd lock files stay reserved until they age past the write grace or prove a dead PID. BREAKS: concurrent detached launches steal reservations and race session state. ENFORCE: `advanced loop resume refuses to relaunch while a fresh empty tmux launch lock is held`. PATTERN_SHAPE: `fs.openSync(lockPath,'wx')` creators whose `EEXIST` path deletes unreadable locks without an mtime grace check.
