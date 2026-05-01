// cli.ts – CLI command handler (mirrors internal/cli/app.go)
import { discover, isBackupRef, type Repository } from "./git.ts";
import { normalizeGraceSeconds, DefaultGraceSeconds } from "./challenge.ts";
import { send as sendNotification } from "./notify.ts";

const INTERRUPTED = Symbol("interrupted");

export interface AppOptions {
  discoverRepo?: (path: string) => Repository;
  now?: () => Date;
  sleep?: (ctx: AbortSignal, ms: number) => Promise<void>;
  notify?: (title: string, message: string) => boolean;
  stdout?: { write(s: string): void };
  stderr?: { write(s: string): void };
  /** Limit start-loop iterations (for testing). 0 = unlimited. */
  startIterations?: number;
}

function defaultSleep(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });
}

function stdoutWriter(s: string) { process.stdout.write(s); }
function stderrWriter(s: string) { process.stderr.write(s); }

export class App {
  private discoverRepo: (path: string) => Repository;
  private now: () => Date;
  private sleep: (signal: AbortSignal, ms: number) => Promise<void>;
  private notify: (title: string, message: string) => boolean;
  private out: (s: string) => void;
  private err: (s: string) => void;
  private startIterations: number;
  private rng: () => number;

  constructor(opts: AppOptions = {}) {
    this.discoverRepo = opts.discoverRepo ?? ((path) => discover(path));
    this.now = opts.now ?? (() => new Date());
    this.sleep = opts.sleep ?? defaultSleep;
    this.notify = opts.notify ?? sendNotification;
    this.out = opts.stdout ? (s) => opts.stdout!.write(s) : stdoutWriter;
    this.err = opts.stderr ? (s) => opts.stderr!.write(s) : stderrWriter;
    this.startIterations = opts.startIterations ?? 0;
    this.rng = Math.random;
  }

  private println(s: string) { this.out(s + "\n"); }
  private eprintln(s: string) { this.err(s + "\n"); }

  private fail(err: unknown): number {
    const msg = err instanceof Error ? err.message : String(err);
    this.eprintln(`git-real: ${msg}`);
    return 1;
  }

  private requireInitialized(repo: Repository): void {
    if (!repo.configBool("gitreal.enabled", false)) {
      throw new Error("repository is not initialized for GitReal; run: git real init");
    }
  }

  async run(signal: AbortSignal, args: string[]): Promise<number> {
    if (args.length === 0) {
      printHelp(this.out);
      return 0;
    }

    const cmd = args[0];
    switch (cmd) {
      case "help":
      case "-h":
      case "--help":
        printHelp(this.out);
        return 0;
      case "init":
        return this.commandInit();
      case "status":
        return this.commandStatus();
      case "once":
        return this.commandOnce(signal, args.slice(1));
      case "start":
        return this.commandStart(signal, args.slice(1));
      case "arm":
        return this.commandArm();
      case "disarm":
        return this.commandDisarm();
      case "rescue":
        return this.commandRescue(args.slice(1));
      default:
        this.eprintln(`git-real: unknown command: ${cmd}`);
        printHelp(this.err);
        return 2;
    }
  }

  private commandInit(): number {
    try {
      const repo = this.discoverRepo(".");
      repo.setConfigBool("gitreal.enabled", true);
      repo.setConfigBool("gitreal.armed", false);
      repo.setConfigInt("gitreal.graceSeconds", DefaultGraceSeconds);
      this.println(`GitReal initialized for: ${repo.root()}`);
      this.println("Mode: dry-run");
      this.println("Run: git real once");
      return 0;
    } catch (e) {
      return this.fail(e);
    }
  }

  private commandStatus(): number {
    try {
      const repo = this.discoverRepo(".");
      let branch = "<unknown>";
      try { branch = repo.currentBranch(); } catch { /* ignore */ }

      let upstream = "<none>";
      let aheadText = "unknown";
      try {
        upstream = repo.upstream();
        try { repo.fetchQuiet(); } catch { /* ignore */ }
        try { aheadText = String(repo.aheadCount()); } catch { /* ignore */ }
      } catch { /* ignore */ }

      this.println(`repo: ${repo.root()}`);
      this.println(`enabled: ${repo.configBool("gitreal.enabled", false)}`);
      this.println(`armed: ${repo.configBool("gitreal.armed", false)}`);
      this.println(`grace-seconds: ${normalizeGraceSeconds(repo.configInt("gitreal.graceSeconds", DefaultGraceSeconds))}`);
      this.println(`branch: ${branch}`);
      this.println(`upstream: ${upstream}`);
      this.println(`ahead: ${aheadText}`);
      return 0;
    } catch (e) {
      return this.fail(e);
    }
  }

  private async commandOnce(signal: AbortSignal, args: string[]): Promise<number> {
    try {
      const repo = this.discoverRepo(".");
      const graceSeconds = resolveGraceSeconds(args, repo, this.err);
      this.requireInitialized(repo);

      try {
        await this.runChallenge(signal, repo, graceSeconds, repo.configBool("gitreal.armed", false));
      } catch (e) {
        if (e === INTERRUPTED) {
          this.println("interrupted; no penalty applied");
          return 0;
        }
        return this.fail(e);
      }
      return 0;
    } catch (e) {
      return this.fail(e);
    }
  }

  private async commandStart(signal: AbortSignal, args: string[]): Promise<number> {
    try {
      const repo = this.discoverRepo(".");
      const graceSeconds = resolveGraceSeconds(args, repo, this.err);
      this.requireInitialized(repo);
      return await this.runStart(signal, repo, graceSeconds, this.startIterations);
    } catch (e) {
      return this.fail(e);
    }
  }

  private async runStart(
    signal: AbortSignal,
    repo: Repository,
    graceSeconds: number,
    iterations: number,
  ): Promise<number> {
    let base = this.now();
    this.println(`GitReal started for ${repo.root()}`);

    let completed = 0;
    while (iterations <= 0 || completed < iterations) {
      if (signal.aborted) {
        this.println("interrupted; stopping scheduler");
        return 0;
      }

      const next = nextRandomSlot(base, this.rng);
      this.println(`next challenge: ${next.toISOString()}`);
      try {
        await this.sleepUntil(signal, next);
      } catch {
        this.println("interrupted; stopping scheduler");
        return 0;
      }

      try {
        await this.runChallenge(signal, repo, graceSeconds, repo.configBool("gitreal.armed", false));
      } catch (e) {
        if (e === INTERRUPTED) {
          this.println("interrupted; stopping scheduler");
          return 0;
        }
        this.eprintln(`git-real: ${e instanceof Error ? e.message : String(e)}`);
      }

      base = new Date(next.getTime() + 3600 * 1000);
      completed++;
    }

    return 0;
  }

  private commandArm(): number {
    try {
      const repo = this.discoverRepo(".");
      this.requireInitialized(repo);
      repo.setConfigBool("gitreal.armed", true);
      this.println("GitReal is now armed for this repository.");
      return 0;
    } catch (e) {
      return this.fail(e);
    }
  }

  private commandDisarm(): number {
    try {
      const repo = this.discoverRepo(".");
      this.requireInitialized(repo);
      repo.setConfigBool("gitreal.armed", false);
      this.println("GitReal is now in dry-run mode for this repository.");
      return 0;
    } catch (e) {
      return this.fail(e);
    }
  }

  private commandRescue(args: string[]): number {
    if (args.length === 0) {
      this.eprintln("git-real rescue: expected subcommand list or restore <ref>");
      return 2;
    }

    let repo: Repository;
    try {
      repo = this.discoverRepo(".");
    } catch (e) {
      return this.fail(e);
    }

    const sub = args[0];
    switch (sub) {
      case "list": {
        if (args.length !== 1) {
          this.eprintln("git-real rescue list: unexpected arguments");
          return 2;
        }
        try {
          const refs = repo.rescueRefs();
          if (refs.length === 0) {
            this.println("No GitReal backup refs found.");
          } else {
            this.println(refs.join("\n"));
          }
          return 0;
        } catch (e) {
          return this.fail(e);
        }
      }
      case "restore": {
        if (args.length !== 2) {
          this.eprintln("git-real rescue restore: expected exactly one backup ref");
          return 2;
        }
        const backupRef = args[1]!;
        if (!isBackupRef(backupRef)) {
          this.eprintln(
            "git-real rescue restore: ref must be a GitReal backup ref produced by 'git real rescue list'",
          );
          return 2;
        }
        return this.restoreBackupRef(repo, backupRef);
      }
      default:
        this.eprintln(`git-real rescue: unknown subcommand: ${sub}`);
        return 2;
    }
  }

  private restoreBackupRef(repo: Repository, backupRef: string): number {
    try {
      const branch = repo.currentBranch();
      const currentBackupRef = repo.backupHead(branch, this.now());

      const stashMessage = `gitreal preserve worktree before rescue restore ${currentBackupRef}`;
      const stashed = repo.stashDirtyWorktree(stashMessage);

      repo.resetHard(backupRef);

      if (stashed) {
        try {
          repo.stashPop();
        } catch {
          this.println("stash pop failed; your stash remains available via git stash list");
        }
      }

      this.println(`Current branch reset to backup ref: ${backupRef}`);
      this.println(`previous HEAD backed up to: ${currentBackupRef}`);
      return 0;
    } catch (e) {
      return this.fail(e);
    }
  }

  private async runChallenge(
    signal: AbortSignal,
    repo: Repository,
    graceSeconds: number,
    armed: boolean,
  ): Promise<void> {
    const branch = repo.currentBranch();
    const upstream = repo.upstream();

    try {
      repo.fetchQuiet();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.println(`preflight fetch failed; continuing with last known upstream state: ${msg}`);
    }

    const ahead = repo.aheadCount();

    this.println(`repo: ${repo.root()}`);
    this.println(`branch: ${branch}`);
    this.println(`upstream: ${upstream}`);
    this.println(`ahead: ${ahead}`);

    if (ahead === 0) {
      this.sendNotification("GitReal", "No unpushed commits. Nothing to do.");
      this.println("nothing to do: no unpushed commits");
      return;
    }

    const deadline = new Date(this.now().getTime() + graceSeconds * 1000);
    this.println(`deadline: ${deadline.toISOString()}`);
    this.sendNotification(
      "GitReal",
      `${branch} has ${ahead} unpushed commit(s). Push before ${deadline.toISOString().slice(11, 19)}.`,
    );

    try {
      await this.sleepUntil(signal, deadline);
    } catch {
      throw INTERRUPTED;
    }

    try {
      repo.fetchQuiet();
    } catch {
      this.sendNotification("GitReal", "fetch failed; punishment skipped for safety.");
      this.println("fetch failed after deadline; punishment skipped for safety");
      return;
    }

    const aheadAfter = repo.aheadCount();

    if (aheadAfter === 0) {
      this.sendNotification("GitReal", "Push confirmed. You are GitReal.");
      this.println("push confirmed");
      return;
    }

    if (!armed) {
      this.sendNotification("GitReal dry-run", `${aheadAfter} commit(s) would be reset.`);
      this.println(`dry-run: would reset ${aheadAfter} commit(s) to @{u}`);
      return;
    }

    if (signal.aborted) {
      this.println("interrupted before reset; punishment skipped");
      throw INTERRUPTED;
    }

    const backupRef = repo.backupHead(branch, this.now());

    const stashMessage = `gitreal preserve worktree before penalty ${backupRef}`;
    const stashed = repo.stashDirtyWorktree(stashMessage);

    repo.resetHard("@{u}");

    if (stashed) {
      try {
        repo.stashPop();
      } catch {
        this.println("stash pop failed; your stash remains available via git stash list");
      }
    }

    this.sendNotification("GitReal", `Local commits made unreal. Backup: ${backupRef}`);
    this.println(`backup ref: ${backupRef}`);
    this.println(`restore: git real rescue restore ${backupRef}`);
  }

  private sendNotification(title: string, message: string): void {
    const ok = this.notify(title, message);
    if (!ok) {
      this.println(`notification: ${title}: ${message}`);
    }
  }

  private async sleepUntil(signal: AbortSignal, target: Date): Promise<void> {
    const ms = target.getTime() - this.now().getTime();
    if (ms <= 0) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      return;
    }
    await this.sleep(signal, ms);
  }
}

function resolveGraceSeconds(args: string[], repo: Repository, errFn: (s: string) => void): number {
  const { value, explicit } = parseGraceSeconds(args, errFn);
  if (explicit) return value;
  return normalizeGraceSeconds(repo.configInt("gitreal.graceSeconds", DefaultGraceSeconds));
}

function parseGraceSeconds(
  args: string[],
  errFn: (s: string) => void,
): { value: number; explicit: boolean } {
  let value = DefaultGraceSeconds;
  let explicit = false;

  for (const arg of args) {
    const m = arg.match(/^--grace-seconds(?:=(.+))?$/);
    if (m) {
      const raw = m[1] ?? args[args.indexOf(arg) + 1];
      if (raw === undefined) {
        errFn("git-real: --grace-seconds requires a value");
        throw new Error("--grace-seconds requires a value");
      }
      const n = parseInt(raw, 10);
      if (isNaN(n)) {
        errFn(`git-real: invalid --grace-seconds value: ${raw}`);
        throw new Error(`invalid --grace-seconds value: ${raw}`);
      }
      value = normalizeGraceSeconds(n);
      explicit = true;
    } else if (!arg.startsWith("-")) {
      errFn(`git-real: unexpected arguments: ${args.filter((a) => !a.startsWith("-")).join(" ")}`);
      throw new Error(`unexpected arguments: ${arg}`);
    }
  }

  return { value, explicit };
}

export function nextRandomSlot(base: Date, rng: () => number): Date {
  // Truncate to the hour
  const windowStart = new Date(base);
  windowStart.setUTCMinutes(0, 0, 0);

  const offsetMs = Math.floor(rng() * 3600) * 1000;
  const slot = new Date(windowStart.getTime() + offsetMs);

  if (slot <= base) {
    const fallbackOffset = Math.floor(rng() * 3600) * 1000;
    return new Date(windowStart.getTime() + 3600 * 1000 + fallbackOffset);
  }
  return slot;
}

export function printHelp(write: (s: string) => void): void {
  write(
    `git-real - BeReal-inspired punishment CLI for Git

Usage:
  git real init
  git real status
  git real once [--grace-seconds=120]
  git real start [--grace-seconds=120]
  git real arm
  git real disarm
  git real rescue list
  git real rescue restore <backup-ref>
`,
  );
}

export function run(signal: AbortSignal, args: string[]): Promise<number> {
  return new App().run(signal, args);
}
