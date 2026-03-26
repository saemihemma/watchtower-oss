import { describe, it, expect } from "vitest";
import {
  cleanupSource,
  isRemoteSource,
  parseSourceInput,
  resolveSource
} from "../src/source-resolver.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("parseSourceInput", () => {
  it("parses local absolute paths", () => {
    const result = parseSourceInput("/home/user/skills");
    expect(result.kind).toBe("local");
    expect(result.localPath).toBe("/home/user/skills");
    expect(result.owner).toBeUndefined();
  });

  it("parses local relative paths", () => {
    const result = parseSourceInput("./test-fixtures/good-skill");
    expect(result.kind).toBe("local");
    expect(result.localPath).toBe("./test-fixtures/good-skill");
  });

  it("parses github:// without ref", () => {
    const result = parseSourceInput("github://saemihemma/watchtower");
    expect(result.kind).toBe("github");
    expect(result.owner).toBe("saemihemma");
    expect(result.repo).toBe("watchtower");
    expect(result.ref).toBeUndefined();
    expect(result.sourceId).toBe("github://saemihemma/watchtower");
  });

  it("parses github:// with branch ref (@)", () => {
    const result = parseSourceInput("github://saemihemma/watchtower@feature-branch");
    expect(result.kind).toBe("github");
    expect(result.owner).toBe("saemihemma");
    expect(result.repo).toBe("watchtower");
    expect(result.ref).toBe("feature-branch");
  });

  it("parses github:// with commit ref (#)", () => {
    const result = parseSourceInput("github://saemihemma/watchtower#abc123def");
    expect(result.kind).toBe("github");
    expect(result.owner).toBe("saemihemma");
    expect(result.repo).toBe("watchtower");
    expect(result.ref).toBe("abc123def");
  });

  it("parses https://github.com URL", () => {
    const result = parseSourceInput("https://github.com/saemihemma/watchtower");
    expect(result.kind).toBe("github");
    expect(result.owner).toBe("saemihemma");
    expect(result.repo).toBe("watchtower");
    expect(result.ref).toBeUndefined();
  });

  it("parses https://github.com URL with .git suffix", () => {
    const result = parseSourceInput("https://github.com/saemihemma/watchtower.git");
    expect(result.kind).toBe("github");
    expect(result.owner).toBe("saemihemma");
    expect(result.repo).toBe("watchtower");
  });

  it("parses https://github.com URL with /tree/branch", () => {
    const result = parseSourceInput("https://github.com/saemihemma/watchtower/tree/v2-stats");
    expect(result.kind).toBe("github");
    expect(result.owner).toBe("saemihemma");
    expect(result.repo).toBe("watchtower");
    expect(result.ref).toBe("v2-stats");
  });

  it("parses https://github.com URL with nested branch path", () => {
    const result = parseSourceInput("https://github.com/owner/repo/tree/feature/my-branch");
    expect(result.kind).toBe("github");
    expect(result.ref).toBe("feature/my-branch");
  });

  it("rejects Watchtower aliases with a clear error", () => {
    expect(() => parseSourceInput("watchtower://starter")).toThrow("Unsupported Watchtower source alias");
  });

  it("throws on invalid github:// format", () => {
    expect(() => parseSourceInput("github://justowner")).toThrow("Expected github://owner/repo");
  });

  it("throws on invalid https URL", () => {
    expect(() => parseSourceInput("https://github.com/justowner")).toThrow("Expected https://github.com/owner/repo");
  });
});

describe("isRemoteSource", () => {
  it("detects github:// as remote", () => {
    expect(isRemoteSource("github://owner/repo")).toBe(true);
  });

  it("detects https://github.com as remote", () => {
    expect(isRemoteSource("https://github.com/owner/repo")).toBe(true);
  });

  it("does not detect local paths as remote", () => {
    expect(isRemoteSource("/home/user/skills")).toBe(false);
    expect(isRemoteSource("./relative/path")).toBe(false);
    expect(isRemoteSource("C:\\Users\\test")).toBe(false);
  });
});

describe("resolveSource — local", () => {
  it("resolves local path to absolute", () => {
    const inputPath = path.join(os.tmpdir(), "watchtower-local-source");
    const result = resolveSource(inputPath);
    expect(result.kind).toBe("local");
    expect(result.localPath).toBe(path.resolve(inputPath));
    expect(result.label).toBe(path.basename(path.resolve(inputPath)));
    expect(result.sourceId).toBe(path.resolve(inputPath));
    expect(result.replaceable).toBe(true);
    expect(result.tempDir).toBeUndefined();
  });

  it("resolves relative local path", () => {
    const result = resolveSource(".");
    expect(result.kind).toBe("local");
    expect(path.isAbsolute(result.localPath)).toBe(true);
    expect(result.tempDir).toBeUndefined();
  });

  it("resolves relative local paths from the caller cwd when provided", () => {
    const originalCallerCwd = process.env.WATCHTOWER_CALLER_CWD;
    const callerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "watchtower-caller-root-"));

    try {
      process.env.WATCHTOWER_CALLER_CWD = callerRoot;
      const result = resolveSource("./skills");
      expect(result.localPath).toBe(path.join(callerRoot, "skills"));
    } finally {
      if (originalCallerCwd === undefined) {
        delete process.env.WATCHTOWER_CALLER_CWD;
      } else {
        process.env.WATCHTOWER_CALLER_CWD = originalCallerCwd;
      }
      fs.rmSync(callerRoot, { recursive: true, force: true });
    }
  });
});

describe("cleanupSource", () => {
  it("cleans up temp directory when present", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "watchtower-test-cleanup-"));
    fs.writeFileSync(path.join(tempDir, "test.txt"), "hello");

    cleanupSource({
      kind: "github",
      originalInput: "test",
      localPath: tempDir,
      label: "test",
      sourceId: "github://example/test",
      replaceable: false,
      tempDir
    });

    expect(fs.existsSync(tempDir)).toBe(false);
  });

  it("does nothing for local sources", () => {
    const localPath = path.resolve(os.tmpdir());
    cleanupSource({
      kind: "local",
      originalInput: localPath,
      localPath,
      label: path.basename(localPath),
      sourceId: localPath,
      replaceable: true
    });
    // Just verify it doesn't throw
    expect(true).toBe(true);
  });

  it("handles already-deleted temp dir gracefully", () => {
    cleanupSource({
      kind: "github",
      originalInput: "test",
      localPath: "/nonexistent/path/watchtower-xxx",
      label: "test",
      sourceId: "github://example/test",
      replaceable: false,
      tempDir: "/nonexistent/path/watchtower-xxx"
    });
    // Should not throw
    expect(true).toBe(true);
  });
});

// Integration test: actual GitHub clone (only runs if git is available)
describe("resolveSource — GitHub clone", () => {
  it("clones a public repo (saemihemma/watchtower)", async () => {
    // Check if git is available
    const { spawnSync } = await import("node:child_process");
    const gitCheck = spawnSync("git", ["--version"], { encoding: "utf8", timeout: 5000 });
    if (gitCheck.status !== 0) {
      console.log("Skipping GitHub clone test: git not available");
      return;
    }

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "watchtower-resolver-test-"));

    try {
      const result = resolveSource("https://github.com/saemihemma/watchtower", tempRoot);

      expect(result.kind).toBe("github");
      expect(result.label).toBe("saemihemma/watchtower");
      expect(result.tempDir).toBeDefined();
      expect(fs.existsSync(result.localPath)).toBe(true);

      // Should have at least a package.json (if the repo was pushed)
      // If not pushed yet, the clone will fail — that's expected
      const hasGit = fs.existsSync(path.join(result.localPath, ".git"));
      expect(hasGit).toBe(true);

      cleanupSource(result);
      expect(fs.existsSync(result.localPath)).toBe(false);
    } catch (error) {
      // If the repo doesn't exist yet, that's fine — just verify the error is sensible
      const msg = error instanceof Error ? error.message : String(error);
      expect(msg).toContain("Failed to clone");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 30_000); // 30s timeout for network
});
