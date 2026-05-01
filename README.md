# gitreal-bun

Bun (TypeScript) reimplementation of [`watany-dev/gitreal`](https://github.com/watany-dev/gitreal) — a BeReal-inspired punishment CLI for Git that turns "I should push later" into a deadline.

When a challenge fires, you have a grace period (default: 2 minutes) to push your local commits. If you miss the window, GitReal can reset your branch back to its upstream state. By default, it stays in dry-run mode so you can try the workflow before enabling destructive behaviour.

## Requirements

- [Bun](https://bun.sh) ≥ 1.0 (macOS or Linux)
- Git

## Install

### From source (macOS / Linux)

```bash
git clone https://github.com/aomona/gitreal-bun.git
cd gitreal-bun
bun install
bun link          # makes `gitreal` available globally
```

### Build a standalone binary

```bash
bun run build     # produces dist/gitreal
# Then copy dist/gitreal somewhere on your $PATH
```

## Quick Start

```bash
gitreal init
gitreal status
gitreal once
```

`gitreal once`, `gitreal start`, `gitreal arm`, and `gitreal disarm` all require `gitreal init` first.  
`gitreal status` and `gitreal rescue ...` are available before initialisation.

Run continuously in the foreground (schedules an hourly random challenge):

```bash
gitreal start
```

## Commands

```
gitreal init
gitreal status
gitreal once [--grace-seconds=120]
gitreal start [--grace-seconds=120]
gitreal arm
gitreal disarm
gitreal rescue list
gitreal rescue restore <backup-ref>
gitreal --version
gitreal --help
```

| Command | Description |
|---|---|
| `init` | Enable GitReal for the current repository and write default config. |
| `status` | Show current repo state, upstream, and ahead count. |
| `once` | Run one challenge immediately. |
| `start` | Stay in the foreground and schedule hourly random challenges. |
| `arm` | Allow real resets for missed deadlines. |
| `disarm` | Return to dry-run mode. |
| `rescue list` | List all backup refs created by GitReal. |
| `rescue restore <ref>` | Reset the current branch to a backup ref. |
| `--version` / `-V` | Print version string. |

## Safety First

- Default mode is **dry-run** — no destructive changes.
- `gitreal arm` explicitly enables real resets.
- Before any reset, GitReal stores the current `HEAD` under `refs/gitreal/backups/…`.
- `gitreal rescue restore <ref>` backs up the current `HEAD` before restoring.
- Dirty worktree changes are stashed and restored when possible.
- `Ctrl-C` (SIGINT/SIGTERM) during a challenge cancels it with no penalty.

## Configuration

GitReal stores settings in Git config (local to each repository):

```bash
git config --local gitreal.enabled true
git config --local gitreal.armed false
git config --local gitreal.graceSeconds 120
```

## Development

```bash
bun install          # install dependencies
bun test             # run all tests
bun run lint         # TypeScript type check
bun run build        # compile standalone binary to dist/gitreal
```

## CLI Compatibility

This implementation matches [`watany-dev/gitreal`](https://github.com/watany-dev/gitreal) (Go version) for:

- Command names and subcommands
- Flag names and defaults (`--grace-seconds`)
- stdout / stderr behaviour and exit codes (0 success, 1 error, 2 usage error)
- Config keys (`gitreal.enabled`, `gitreal.armed`, `gitreal.graceSeconds`)
- Backup ref format (`refs/gitreal/backups/<branch>/<timestamp>`)
- Notification fallback to stdout when desktop notifications are unavailable