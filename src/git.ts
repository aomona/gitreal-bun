// git.ts – git operations wrapper (mirrors internal/git/git.go)
import { spawnSync } from "child_process";
import { createHash } from "crypto";

const BACKUP_REF_PREFIX = "refs/gitreal/backups/";
const MAX_SAFE_BRANCH_BYTES = 64;

// Matches the exact shape BackupHead produces:
//   refs/gitreal/backups/<safeBranch>/<YYYYMMDDTHHMMSSZ>-<nanoseconds>
const BACKUP_REF_PATTERN =
  /^refs\/gitreal\/backups\/[A-Za-z0-9._-]+\/[0-9]{8}T[0-9]{6}Z-[0-9]{9}$/;

const SAFE_BRANCH_ALLOWED = /[^A-Za-z0-9._-]+/g;

export interface Repository {
  root(): string;
  setConfigBool(key: string, value: boolean): void;
  setConfigInt(key: string, value: number): void;
  configBool(key: string, fallback: boolean): boolean;
  configInt(key: string, fallback: number): number;
  currentBranch(): string;
  upstream(): string;
  fetchQuiet(): void;
  aheadCount(): number;
  backupHead(branch: string, now: Date): string;
  stashDirtyWorktree(message: string): boolean;
  stashPop(): void;
  resetHard(ref: string): void;
  rescueRefs(): string[];
}

export interface Runner {
  run(dir: string, args: string[]): string;
}

export class CommandRunner implements Runner {
  run(dir: string, args: string[]): string {
    const result = spawnSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
    });
    if (result.status !== 0) {
      const stderr = (result.stderr ?? "").toString().trim();
      const stdout = (result.stdout ?? "").toString().trim();
      const msg = stderr || stdout;
      throw new Error(`git ${args.join(" ")} failed: ${msg}`);
    }
    return (result.stdout ?? "").toString();
  }
}

export class GitRepository implements Repository {
  private _root: string;
  private runner: Runner;

  constructor(root: string, runner: Runner = new CommandRunner()) {
    this._root = root;
    this.runner = runner;
  }

  root(): string {
    return this._root;
  }

  private run(...args: string[]): string {
    return this.runner.run(this._root, args);
  }

  setConfigBool(key: string, value: boolean): void {
    this.run("config", "--local", key, value ? "true" : "false");
  }

  setConfigInt(key: string, value: number): void {
    this.run("config", "--local", key, String(value));
  }

  configBool(key: string, fallback: boolean): boolean {
    try {
      const out = this.run("config", "--bool", "--get", key).trim().toLowerCase();
      if (["true", "yes", "on", "1"].includes(out)) return true;
      if (["false", "no", "off", "0"].includes(out)) return false;
      return fallback;
    } catch {
      return fallback;
    }
  }

  configInt(key: string, fallback: number): number {
    try {
      const out = this.run("config", "--int", "--get", key).trim();
      const n = parseInt(out, 10);
      return isNaN(n) ? fallback : n;
    } catch {
      return fallback;
    }
  }

  currentBranch(): string {
    try {
      return this.run("symbolic-ref", "--quiet", "--short", "HEAD").trim();
    } catch {
      throw new Error("detached HEAD is not supported");
    }
  }

  upstream(): string {
    try {
      return this.run("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}").trim();
    } catch {
      throw new Error("no upstream configured; run: git push -u origin HEAD");
    }
  }

  fetchQuiet(): void {
    this.run("fetch", "--quiet", "--prune");
  }

  aheadCount(): number {
    const out = this.run("rev-list", "--count", "@{u}..HEAD").trim();
    if (!out) return 0;
    const n = parseInt(out, 10);
    if (isNaN(n)) throw new Error(`unexpected ahead count output: ${out}`);
    return n;
  }

  backupHead(branch: string, now: Date): string {
    const safeBranch = sanitizeBranchSegment(branch);
    const timestamp = formatBackupTimestamp(now);
    const backupRef = `${BACKUP_REF_PREFIX}${safeBranch}/${timestamp}`;

    if (!BACKUP_REF_PATTERN.test(backupRef)) {
      throw new Error(`refusing to write malformed backup ref: ${JSON.stringify(backupRef)}`);
    }

    this.run("update-ref", backupRef, "HEAD");
    return backupRef;
  }

  stashDirtyWorktree(message: string): boolean {
    const out = this.run("status", "--porcelain=v1", "-z");
    if (!out) return false;
    this.run("stash", "push", "--include-untracked", "--message", message);
    return true;
  }

  stashPop(): void {
    this.run("stash", "pop");
  }

  resetHard(ref: string): void {
    this.run("reset", "--hard", ref);
  }

  rescueRefs(): string[] {
    try {
      const out = this.run("for-each-ref", BACKUP_REF_PREFIX, "--format=%(refname)").trim();
      if (!out) return [];
      return out.split("\n");
    } catch {
      return [];
    }
  }
}

export function discover(path: string, runner?: Runner): GitRepository {
  const r = runner ?? new CommandRunner();
  try {
    const out = r.run(path, ["rev-parse", "--show-toplevel"]);
    return new GitRepository(out.trim(), r);
  } catch {
    throw new Error("not inside a Git repository");
  }
}

/** Reports whether ref is a well-formed GitReal backup ref produced by backupHead. */
export function isBackupRef(ref: string): boolean {
  return BACKUP_REF_PATTERN.test(ref);
}

/**
 * Maps an arbitrary branch name to a single ref path segment matching [A-Za-z0-9._-]+.
 * Falls back to a hash if the name is empty or too long.
 */
export function sanitizeBranchSegment(branch: string): string {
  let collapsed = branch.replace(SAFE_BRANCH_ALLOWED, "-").replace(/^[-.]|[-.]$/g, "");
  // Collapse consecutive dashes
  while (collapsed.includes("--")) {
    collapsed = collapsed.replace(/--/g, "-");
  }

  if (!collapsed || collapsed.length > MAX_SAFE_BRANCH_BYTES) {
    const hash = createHash("sha256").update(branch).digest("hex");
    return "branch-" + hash.slice(0, 12);
  }
  return collapsed;
}

/**
 * Formats a Date as the timestamp segment used in backup refs:
 *   <YYYYMMDDTHHMMSSZ>-<nanoseconds (9 digits, zero-padded)>
 *
 * JavaScript only has millisecond precision, so we pad nanos with zeros.
 */
export function formatBackupTimestamp(now: Date): string {
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  const Y = now.getUTCFullYear();
  const Mo = now.getUTCMonth() + 1;
  const D = now.getUTCDate();
  const H = now.getUTCHours();
  const Mi = now.getUTCMinutes();
  const S = now.getUTCSeconds();
  const ms = now.getUTCMilliseconds();
  // 9-digit nanoseconds: milliseconds * 1_000_000, padded to 9 digits
  const nanos = pad(ms * 1_000_000, 9);
  return `${pad(Y, 4)}${pad(Mo, 2)}${pad(D, 2)}T${pad(H, 2)}${pad(Mi, 2)}${pad(S, 2)}Z-${nanos}`;
}
