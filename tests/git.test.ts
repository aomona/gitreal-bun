// tests/git.test.ts – unit tests for git.ts helpers
import { describe, expect, it } from "bun:test";
import {
  sanitizeBranchSegment,
  formatBackupTimestamp,
  isBackupRef,
  GitRepository,
  type Runner,
} from "../src/git.ts";

describe("sanitizeBranchSegment", () => {
  it("keeps simple alphanumeric branch names unchanged", () => {
    expect(sanitizeBranchSegment("main")).toBe("main");
    expect(sanitizeBranchSegment("feature-123")).toBe("feature-123");
  });

  it("replaces disallowed characters with dashes", () => {
    expect(sanitizeBranchSegment("feature/my-branch")).toBe("feature-my-branch");
  });

  it("collapses consecutive dashes", () => {
    expect(sanitizeBranchSegment("a//b")).toBe("a-b");
  });

  it("strips leading and trailing dots and dashes", () => {
    expect(sanitizeBranchSegment("-branch-")).toBe("branch");
    expect(sanitizeBranchSegment(".branch.")).toBe("branch");
  });

  it("falls back to hash for empty input", () => {
    const result = sanitizeBranchSegment("");
    expect(result).toMatch(/^branch-[0-9a-f]{12}$/);
  });

  it("falls back to hash for very long branch names", () => {
    const long = "a".repeat(65);
    const result = sanitizeBranchSegment(long);
    expect(result).toMatch(/^branch-[0-9a-f]{12}$/);
  });
});

describe("formatBackupTimestamp", () => {
  it("formats a date as <YYYYMMDDTHHMMSSZ>-<9-digit-nanos>", () => {
    const d = new Date("2024-06-15T12:34:56.789Z");
    const ts = formatBackupTimestamp(d);
    expect(ts).toBe("20240615T123456Z-789000000");
  });

  it("pads nanoseconds to 9 digits", () => {
    const d = new Date("2024-01-01T00:00:00.001Z");
    const ts = formatBackupTimestamp(d);
    expect(ts).toBe("20240101T000000Z-001000000");
  });
});

describe("isBackupRef", () => {
  it("accepts a well-formed backup ref", () => {
    expect(isBackupRef("refs/gitreal/backups/main/20240615T123456Z-000000000")).toBe(true);
    expect(isBackupRef("refs/gitreal/backups/feature-x/20240615T000000Z-789000000")).toBe(true);
  });

  it("rejects refs that do not match the pattern", () => {
    expect(isBackupRef("refs/heads/main")).toBe(false);
    expect(isBackupRef("refs/gitreal/backups/main/bad-timestamp")).toBe(false);
    expect(isBackupRef("refs/gitreal/backups/main/20240615T123456Z-000000000/extra")).toBe(false);
    expect(isBackupRef("refs/gitreal/backups/../evil/20240615T123456Z-000000000")).toBe(false);
  });
});

// --- GitRepository with a fake runner ---

class FakeRunner implements Runner {
  calls: Array<{ dir: string; args: string[] }> = [];
  responses: Map<string, string> = new Map();
  errors: Map<string, string> = new Map();

  addResponse(argsKey: string, response: string) {
    this.responses.set(argsKey, response);
  }

  addError(argsKey: string, message: string) {
    this.errors.set(argsKey, message);
  }

  run(dir: string, args: string[]): string {
    this.calls.push({ dir, args });
    const key = args.join(" ");
    if (this.errors.has(key)) {
      throw new Error(this.errors.get(key));
    }
    return this.responses.get(key) ?? "";
  }
}

describe("GitRepository", () => {
  it("root() returns the root path", () => {
    const repo = new GitRepository("/my/repo");
    expect(repo.root()).toBe("/my/repo");
  });

  it("configBool() returns fallback on error", () => {
    const runner = new FakeRunner();
    runner.addError("config --bool --get gitreal.enabled", "not set");
    const repo = new GitRepository("/repo", runner);
    expect(repo.configBool("gitreal.enabled", true)).toBe(true);
    expect(repo.configBool("gitreal.enabled", false)).toBe(false);
  });

  it("configBool() parses 'true' correctly", () => {
    const runner = new FakeRunner();
    runner.addResponse("config --bool --get gitreal.enabled", "true\n");
    const repo = new GitRepository("/repo", runner);
    expect(repo.configBool("gitreal.enabled", false)).toBe(true);
  });

  it("configInt() returns fallback on error", () => {
    const runner = new FakeRunner();
    runner.addError("config --int --get gitreal.graceSeconds", "not set");
    const repo = new GitRepository("/repo", runner);
    expect(repo.configInt("gitreal.graceSeconds", 120)).toBe(120);
  });

  it("configInt() parses integer correctly", () => {
    const runner = new FakeRunner();
    runner.addResponse("config --int --get gitreal.graceSeconds", "60\n");
    const repo = new GitRepository("/repo", runner);
    expect(repo.configInt("gitreal.graceSeconds", 120)).toBe(60);
  });

  it("currentBranch() returns trimmed branch name", () => {
    const runner = new FakeRunner();
    runner.addResponse("symbolic-ref --quiet --short HEAD", "main\n");
    const repo = new GitRepository("/repo", runner);
    expect(repo.currentBranch()).toBe("main");
  });

  it("currentBranch() throws on detached HEAD", () => {
    const runner = new FakeRunner();
    runner.addError("symbolic-ref --quiet --short HEAD", "fatal: ref HEAD is not a symbolic ref");
    const repo = new GitRepository("/repo", runner);
    expect(() => repo.currentBranch()).toThrow("detached HEAD is not supported");
  });

  it("upstream() throws when no upstream", () => {
    const runner = new FakeRunner();
    runner.addError(
      "rev-parse --abbrev-ref --symbolic-full-name @{u}",
      "fatal: no upstream configured",
    );
    const repo = new GitRepository("/repo", runner);
    expect(() => repo.upstream()).toThrow("no upstream configured");
  });

  it("aheadCount() returns 0 for empty output", () => {
    const runner = new FakeRunner();
    runner.addResponse("rev-list --count @{u}..HEAD", "\n");
    const repo = new GitRepository("/repo", runner);
    expect(repo.aheadCount()).toBe(0);
  });

  it("aheadCount() parses correctly", () => {
    const runner = new FakeRunner();
    runner.addResponse("rev-list --count @{u}..HEAD", "3\n");
    const repo = new GitRepository("/repo", runner);
    expect(repo.aheadCount()).toBe(3);
  });

  it("stashDirtyWorktree() returns false on clean worktree", () => {
    const runner = new FakeRunner();
    runner.addResponse("status --porcelain=v1 -z", "");
    const repo = new GitRepository("/repo", runner);
    expect(repo.stashDirtyWorktree("msg")).toBe(false);
  });

  it("stashDirtyWorktree() stashes and returns true on dirty worktree", () => {
    const runner = new FakeRunner();
    runner.addResponse("status --porcelain=v1 -z", " M src/index.ts\0");
    runner.addResponse("stash push --include-untracked --message msg", "Saved working directory");
    const repo = new GitRepository("/repo", runner);
    expect(repo.stashDirtyWorktree("msg")).toBe(true);
  });

  it("rescueRefs() returns empty array on no refs", () => {
    const runner = new FakeRunner();
    runner.addResponse("for-each-ref refs/gitreal/backups/ --format=%(refname)", "");
    const repo = new GitRepository("/repo", runner);
    expect(repo.rescueRefs()).toEqual([]);
  });

  it("rescueRefs() returns split list of refs", () => {
    const runner = new FakeRunner();
    runner.addResponse(
      "for-each-ref refs/gitreal/backups/ --format=%(refname)",
      "refs/gitreal/backups/main/20240615T000000Z-000000000\nrefs/gitreal/backups/main/20240616T000000Z-000000000\n",
    );
    const repo = new GitRepository("/repo", runner);
    expect(repo.rescueRefs()).toEqual([
      "refs/gitreal/backups/main/20240615T000000Z-000000000",
      "refs/gitreal/backups/main/20240616T000000Z-000000000",
    ]);
  });
});
