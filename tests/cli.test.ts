// tests/cli.test.ts – unit tests for cli.ts (mirrors internal/cli/app_test.go)
import { describe, expect, it } from "bun:test";
import { App, nextRandomSlot, printHelp, type AppOptions } from "../src/cli.ts";
import type { Repository } from "../src/git.ts";

// --- Fake repository ---

type FakeRepoConfig = {
  boolValues?: Record<string, boolean>;
  intValues?: Record<string, number>;
  currentBranch?: string | Error;
  upstream?: string | Error;
  aheadCount?: number | Error;
  rescueRefs?: string[];
  fetchError?: Error;
};

function makeRepo(cfg: FakeRepoConfig = {}): Repository & {
  setConfigCalls: Array<{ key: string; value: boolean | number }>;
  stashMessages: string[];
  resetRefs: string[];
  stashPopCalls: number;
  stashed: boolean;
  updateRefCalls: Array<{ ref: string }>;
} {
  const bools: Record<string, boolean> = cfg.boolValues ?? {};
  const ints: Record<string, number> = cfg.intValues ?? {};
  const setConfigCalls: Array<{ key: string; value: boolean | number }> = [];
  const stashMessages: string[] = [];
  const resetRefs: string[] = [];
  const updateRefCalls: Array<{ ref: string }> = [];
  let stashPopCalls = 0;
  let stashed = false;

  return {
    setConfigCalls,
    stashMessages,
    resetRefs,
    updateRefCalls,
    get stashPopCalls() { return stashPopCalls; },
    get stashed() { return stashed; },

    root: () => "/fake/repo",
    setConfigBool: (key, value) => {
      bools[key] = value;
      setConfigCalls.push({ key, value });
    },
    setConfigInt: (key, value) => {
      ints[key] = value;
      setConfigCalls.push({ key, value });
    },
    configBool: (key, fallback) => bools[key] ?? fallback,
    configInt: (key, fallback) => ints[key] ?? fallback,
    currentBranch: () => {
      if (cfg.currentBranch instanceof Error) throw cfg.currentBranch;
      return cfg.currentBranch ?? "main";
    },
    upstream: () => {
      if (cfg.upstream instanceof Error) throw cfg.upstream;
      return cfg.upstream ?? "origin/main";
    },
    fetchQuiet: () => {
      if (cfg.fetchError) throw cfg.fetchError;
    },
    aheadCount: () => {
      if (cfg.aheadCount instanceof Error) throw cfg.aheadCount;
      return cfg.aheadCount ?? 0;
    },
    backupHead: (_branch, _now) => {
      const ref = "refs/gitreal/backups/main/20240615T000000Z-000000000";
      updateRefCalls.push({ ref });
      return ref;
    },
    stashDirtyWorktree: (msg) => {
      stashMessages.push(msg);
      stashed = true;
      return stashed;
    },
    stashPop: () => { stashPopCalls++; },
    resetHard: (ref) => { resetRefs.push(ref); },
    rescueRefs: () => cfg.rescueRefs ?? [],
  };
}

function makeApp(repo: Repository, extra: Partial<AppOptions> = {}): {
  app: App;
  stdout: string[];
  stderr: string[];
  signal: AbortSignal;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const controller = new AbortController();

  const app = new App({
    discoverRepo: () => repo,
    now: () => new Date("2024-06-15T12:00:00Z"),
    sleep: (_signal, _ms) => Promise.resolve(),
    notify: (_t, _m) => true,
    stdout: { write: (s) => { stdout.push(s); } },
    stderr: { write: (s) => { stderr.push(s); } },
    ...extra,
  });

  return { app, stdout, stderr, signal: controller.signal };
}

// --- Tests ---

describe("App.run – help", () => {
  it("prints help when no args", async () => {
    const { app, stdout, signal } = makeApp(makeRepo());
    const code = await app.run(signal, []);
    expect(code).toBe(0);
    expect(stdout.join("")).toContain("git-real");
  });

  it("prints help for 'help' command", async () => {
    const { app, stdout, signal } = makeApp(makeRepo());
    const code = await app.run(signal, ["help"]);
    expect(code).toBe(0);
    expect(stdout.join("")).toContain("Usage:");
  });

  it("returns exit code 2 for unknown command", async () => {
    const { app, stderr, signal } = makeApp(makeRepo());
    const code = await app.run(signal, ["bogus"]);
    expect(code).toBe(2);
    expect(stderr.join("")).toContain("unknown command: bogus");
  });
});

describe("App – init", () => {
  it("sets gitreal config keys and prints initialization message", async () => {
    const repo = makeRepo();
    const { app, stdout, signal } = makeApp(repo);
    const code = await app.run(signal, ["init"]);
    expect(code).toBe(0);
    expect(stdout.join("")).toContain("GitReal initialized for:");
    expect(stdout.join("")).toContain("dry-run");

    const keys = repo.setConfigCalls.map((c) => c.key);
    expect(keys).toContain("gitreal.enabled");
    expect(keys).toContain("gitreal.armed");
    expect(keys).toContain("gitreal.graceSeconds");
  });
});

describe("App – status", () => {
  it("prints repo status fields", async () => {
    const repo = makeRepo({
      boolValues: { "gitreal.enabled": true, "gitreal.armed": false },
      intValues: { "gitreal.graceSeconds": 120 },
      aheadCount: 2,
    });
    const { app, stdout, signal } = makeApp(repo);
    const code = await app.run(signal, ["status"]);
    expect(code).toBe(0);
    const out = stdout.join("");
    expect(out).toContain("repo:");
    expect(out).toContain("enabled: true");
    expect(out).toContain("armed: false");
    expect(out).toContain("grace-seconds: 120");
    expect(out).toContain("branch: main");
    expect(out).toContain("upstream: origin/main");
    expect(out).toContain("ahead: 2");
  });

  it("shows unknown/none when no upstream configured", async () => {
    const repo = makeRepo({ upstream: new Error("no upstream") });
    const { app, stdout, signal } = makeApp(repo);
    await app.run(signal, ["status"]);
    const out = stdout.join("");
    expect(out).toContain("upstream: <none>");
    expect(out).toContain("ahead: unknown");
  });
});

describe("App – arm / disarm", () => {
  it("arm requires initialization", async () => {
    const repo = makeRepo({ boolValues: { "gitreal.enabled": false } });
    const { app, stderr, signal } = makeApp(repo);
    const code = await app.run(signal, ["arm"]);
    expect(code).toBe(1);
    expect(stderr.join("")).toContain("not initialized");
  });

  it("arm sets gitreal.armed to true", async () => {
    const repo = makeRepo({ boolValues: { "gitreal.enabled": true } });
    const { app, stdout, signal } = makeApp(repo);
    const code = await app.run(signal, ["arm"]);
    expect(code).toBe(0);
    expect(stdout.join("")).toContain("armed");
    const armedCall = repo.setConfigCalls.find((c) => c.key === "gitreal.armed");
    expect(armedCall?.value).toBe(true);
  });

  it("disarm sets gitreal.armed to false", async () => {
    const repo = makeRepo({ boolValues: { "gitreal.enabled": true, "gitreal.armed": true } });
    const { app, stdout, signal } = makeApp(repo);
    const code = await app.run(signal, ["disarm"]);
    expect(code).toBe(0);
    expect(stdout.join("")).toContain("dry-run");
    const armedCall = repo.setConfigCalls.find((c) => c.key === "gitreal.armed");
    expect(armedCall?.value).toBe(false);
  });
});

describe("App – once", () => {
  it("requires initialization", async () => {
    const repo = makeRepo({ boolValues: { "gitreal.enabled": false } });
    const { app, stderr, signal } = makeApp(repo);
    const code = await app.run(signal, ["once"]);
    expect(code).toBe(1);
    expect(stderr.join("")).toContain("not initialized");
  });

  it("prints 'nothing to do' when ahead count is 0", async () => {
    const repo = makeRepo({
      boolValues: { "gitreal.enabled": true },
      aheadCount: 0,
    });
    const { app, stdout, signal } = makeApp(repo);
    const code = await app.run(signal, ["once"]);
    expect(code).toBe(0);
    expect(stdout.join("")).toContain("nothing to do");
  });

  it("dry-run mode prints dry-run message when ahead > 0 and not armed", async () => {
    const repo = makeRepo({
      boolValues: { "gitreal.enabled": true, "gitreal.armed": false },
      aheadCount: 3,
    });
    const { app, stdout, signal } = makeApp(repo);
    const code = await app.run(signal, ["once"]);
    expect(code).toBe(0);
    expect(stdout.join("")).toContain("dry-run: would reset 3 commit(s)");
  });

  it("armed mode resets and writes backup ref", async () => {
    const repo = makeRepo({
      boolValues: { "gitreal.enabled": true, "gitreal.armed": true },
      aheadCount: 2,
    });
    const { app, stdout, signal } = makeApp(repo);
    const code = await app.run(signal, ["once"]);
    expect(code).toBe(0);
    const out = stdout.join("");
    expect(out).toContain("backup ref:");
    expect(out).toContain("restore: git real rescue restore");
    expect(repo.resetRefs).toContain("@{u}");
  });

  it("respects --grace-seconds flag", async () => {
    const repo = makeRepo({
      boolValues: { "gitreal.enabled": true },
      aheadCount: 0,
    });
    const { app, signal } = makeApp(repo);
    const code = await app.run(signal, ["once", "--grace-seconds=60"]);
    expect(code).toBe(0);
  });
});

describe("App – rescue list", () => {
  it("prints 'No GitReal backup refs found' when list is empty", async () => {
    const repo = makeRepo({ rescueRefs: [] });
    const { app, stdout, signal } = makeApp(repo);
    const code = await app.run(signal, ["rescue", "list"]);
    expect(code).toBe(0);
    expect(stdout.join("")).toContain("No GitReal backup refs found");
  });

  it("prints refs when list is non-empty", async () => {
    const repo = makeRepo({
      rescueRefs: [
        "refs/gitreal/backups/main/20240615T000000Z-000000000",
        "refs/gitreal/backups/main/20240616T000000Z-000000000",
      ],
    });
    const { app, stdout, signal } = makeApp(repo);
    const code = await app.run(signal, ["rescue", "list"]);
    expect(code).toBe(0);
    const out = stdout.join("");
    expect(out).toContain("refs/gitreal/backups/main/20240615T000000Z-000000000");
    expect(out).toContain("refs/gitreal/backups/main/20240616T000000Z-000000000");
  });
});

describe("App – rescue restore", () => {
  it("returns error for missing backup ref argument", async () => {
    const repo = makeRepo();
    const { app, stderr, signal } = makeApp(repo);
    const code = await app.run(signal, ["rescue", "restore"]);
    expect(code).toBe(2);
    expect(stderr.join("")).toContain("expected exactly one backup ref");
  });

  it("rejects non-backup refs", async () => {
    const repo = makeRepo();
    const { app, stderr, signal } = makeApp(repo);
    const code = await app.run(signal, ["rescue", "restore", "refs/heads/main"]);
    expect(code).toBe(2);
    expect(stderr.join("")).toContain("must be a GitReal backup ref");
  });

  it("restores a valid backup ref and prints confirmation", async () => {
    const repo = makeRepo();
    const { app, stdout, signal } = makeApp(repo);
    const code = await app.run(signal, [
      "rescue",
      "restore",
      "refs/gitreal/backups/main/20240615T000000Z-000000000",
    ]);
    expect(code).toBe(0);
    const out = stdout.join("");
    expect(out).toContain("Current branch reset to backup ref:");
    expect(out).toContain("previous HEAD backed up to:");
    expect(repo.resetRefs).toContain("refs/gitreal/backups/main/20240615T000000Z-000000000");
  });

  it("rescue without subcommand returns error", async () => {
    const repo = makeRepo();
    const { app, stderr, signal } = makeApp(repo);
    const code = await app.run(signal, ["rescue"]);
    expect(code).toBe(2);
    expect(stderr.join("")).toContain("expected subcommand");
  });
});

describe("nextRandomSlot", () => {
  it("returns a time after base", () => {
    const base = new Date("2024-06-15T12:30:00Z");
    // Deterministic rng: always 0 → slot = windowStart (12:00) which is before base → fallback
    const slot = nextRandomSlot(base, () => 0);
    expect(slot > base).toBe(true);
  });

  it("returns a time within the same or next hour window", () => {
    const base = new Date("2024-06-15T12:00:00Z");
    for (let i = 0; i < 20; i++) {
      const slot = nextRandomSlot(base, Math.random);
      expect(slot >= base).toBe(true);
    }
  });
});

describe("printHelp", () => {
  it("includes all commands", () => {
    const lines: string[] = [];
    printHelp((s) => lines.push(s));
    const out = lines.join("");
    expect(out).toContain("git real init");
    expect(out).toContain("git real status");
    expect(out).toContain("git real once");
    expect(out).toContain("git real start");
    expect(out).toContain("git real arm");
    expect(out).toContain("git real disarm");
    expect(out).toContain("git real rescue list");
    expect(out).toContain("git real rescue restore");
  });
});
