/**
 * Source resolver: accepts local paths, GitHub URLs, or HTTPS git URLs
 * and resolves them all to local filesystem paths.
 *
 * Supported input formats:
 *   /absolute/local/path           → local
 *   C:\Windows\path                → local
 *   github://owner/repo            → GitHub, default branch
 *   github://owner/repo@branch     → GitHub, specific branch/tag
 *   github://owner/repo#sha        → GitHub, specific commit
 *   https://github.com/owner/repo  → GitHub (auto-detected from URL)
 *   https://github.com/owner/repo/tree/branch → GitHub with branch
 */

import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sha256Bytes } from "./files.js";

export type SourceKind = "local" | "github";

export type ParsedSource = {
  kind: SourceKind;
  owner?: string;
  repo?: string;
  ref?: string;
  localPath?: string;
  originalInput: string;
};

export type ResolvedSource = {
  kind: SourceKind;
  originalInput: string;
  localPath: string;
  label: string;
  ref?: string;
  tempDir?: string; // set if we cloned; caller must cleanup
};

/**
 * Parse a source input string into its components.
 */
export function parseSourceInput(input: string): ParsedSource {
  const trimmed = input.trim();

  // github:// protocol
  if (trimmed.startsWith("github://")) {
    return parseGithubProtocol(trimmed);
  }

  // https://github.com/... URL
  if (/^https?:\/\/github\.com\//i.test(trimmed)) {
    return parseGithubHttpsUrl(trimmed);
  }

  // Everything else is a local path
  return {
    kind: "local",
    localPath: trimmed,
    originalInput: trimmed
  };
}

function parseGithubProtocol(input: string): ParsedSource {
  // github://owner/repo[@ref | #sha]
  const withoutProtocol = input.replace(/^github:\/\//, "");

  let ownerRepo: string;
  let ref: string | undefined;

  if (withoutProtocol.includes("#")) {
    const [base, sha] = withoutProtocol.split("#", 2);
    ownerRepo = base;
    ref = sha;
  } else if (withoutProtocol.includes("@")) {
    const [base, branch] = withoutProtocol.split("@", 2);
    ownerRepo = base;
    ref = branch;
  } else {
    ownerRepo = withoutProtocol;
  }

  const [owner, repo] = ownerRepo.split("/", 2);
  if (!owner || !repo) {
    throw new Error(`Invalid GitHub source: ${input}. Expected github://owner/repo`);
  }

  return {
    kind: "github",
    owner,
    repo: repo.replace(/\.git$/, ""),
    ref: ref || undefined,
    originalInput: input
  };
}

function parseGithubHttpsUrl(input: string): ParsedSource {
  // https://github.com/owner/repo[/tree/branch]
  const url = new URL(input);
  const segments = url.pathname.replace(/^\//, "").replace(/\.git$/, "").split("/");

  const owner = segments[0];
  const repo = segments[1];
  if (!owner || !repo) {
    throw new Error(`Invalid GitHub URL: ${input}. Expected https://github.com/owner/repo`);
  }

  let ref: string | undefined;
  // /tree/branch-name or /tree/branch/with/slashes
  if (segments[2] === "tree" && segments.length > 3) {
    ref = segments.slice(3).join("/");
  }

  return {
    kind: "github",
    owner,
    repo,
    ref: ref || undefined,
    originalInput: input
  };
}

/**
 * Create a stable temp directory name for a given GitHub source.
 */
function tempDirName(owner: string, repo: string, ref?: string): string {
  const key = `${owner}/${repo}/${ref ?? "HEAD"}`;
  const hash = sha256Bytes(key).slice(0, 12);
  return `watchtower-github-${owner}-${repo}-${hash}`;
}

/**
 * Clone a GitHub repository to a temporary directory.
 * Uses shallow clone for speed. Returns the local path.
 */
function cloneGitHub(parsed: ParsedSource, tempRoot: string): string {
  const { owner, repo, ref } = parsed;
  if (!owner || !repo) {
    throw new Error("Cannot clone: missing owner or repo");
  }

  const dirName = tempDirName(owner, repo, ref);
  const destDir = path.join(tempRoot, dirName);

  // If already cloned (cached from a previous call in same session), reuse
  if (fs.existsSync(path.join(destDir, ".git"))) {
    return destDir;
  }

  // Clean up any partial clone
  if (fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true, force: true });
  }

  const cloneUrl = `https://github.com/${owner}/${repo}.git`;

  // Build clone args
  const args: string[] = ["clone", "--depth", "1"];

  if (ref) {
    // Try branch/tag first
    args.push("--branch", ref);
  }

  args.push(cloneUrl, destDir);

  const result = childProcess.spawnSync("git", args, {
    encoding: "utf8",
    timeout: 120_000, // 2 minute timeout
    stdio: ["ignore", "pipe", "pipe"]
  });

  if (result.status !== 0) {
    // If ref failed as branch, it might be a commit SHA — try full clone + checkout
    if (ref && result.stderr?.includes("not found")) {
      return cloneGitHubAtCommit(owner, repo, ref, destDir);
    }

    const stderr = (result.stderr ?? "").trim().slice(0, 500);
    throw new Error(
      `Failed to clone ${cloneUrl}${ref ? ` (ref: ${ref})` : ""}. ` +
      `Exit code ${result.status}. ${stderr}\n` +
      `Check that the repository exists, is public (or you have git credentials configured), and the branch/tag exists.`
    );
  }

  return destDir;
}

/**
 * Clone at a specific commit SHA (requires fetching the commit directly).
 */
function cloneGitHubAtCommit(owner: string, repo: string, sha: string, destDir: string): string {
  const cloneUrl = `https://github.com/${owner}/${repo}.git`;

  // Clean up any partial clone
  if (fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true, force: true });
  }

  // Init + fetch specific commit
  fs.mkdirSync(destDir, { recursive: true });

  const init = childProcess.spawnSync("git", ["init"], {
    cwd: destDir, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"]
  });
  if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);

  const addRemote = childProcess.spawnSync("git", ["remote", "add", "origin", cloneUrl], {
    cwd: destDir, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"]
  });
  if (addRemote.status !== 0) throw new Error(`git remote add failed: ${addRemote.stderr}`);

  const fetch = childProcess.spawnSync("git", ["fetch", "--depth", "1", "origin", sha], {
    cwd: destDir, encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"]
  });
  if (fetch.status !== 0) {
    fs.rmSync(destDir, { recursive: true, force: true });
    throw new Error(`Failed to fetch commit ${sha} from ${cloneUrl}. ${(fetch.stderr ?? "").slice(0, 300)}`);
  }

  const checkout = childProcess.spawnSync("git", ["checkout", "FETCH_HEAD"], {
    cwd: destDir, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"]
  });
  if (checkout.status !== 0) {
    throw new Error(`Failed to checkout ${sha}: ${(checkout.stderr ?? "").slice(0, 300)}`);
  }

  return destDir;
}

/**
 * Resolve any source input to a local filesystem path.
 * For GitHub sources, clones to a temp directory.
 */
export function resolveSource(input: string, tempRoot?: string): ResolvedSource {
  const parsed = parseSourceInput(input);

  if (parsed.kind === "local") {
    const localPath = path.resolve(parsed.localPath!);
    const label = path.basename(localPath);
    return {
      kind: "local",
      originalInput: input,
      localPath,
      label
    };
  }

  // GitHub source — clone it
  const effectiveTempRoot = tempRoot ?? path.join(os.tmpdir(), "watchtower-clones");
  fs.mkdirSync(effectiveTempRoot, { recursive: true });

  const localPath = cloneGitHub(parsed, effectiveTempRoot);
  const refLabel = parsed.ref ? `@${parsed.ref}` : "";
  const label = `${parsed.owner}/${parsed.repo}${refLabel}`;

  return {
    kind: "github",
    originalInput: input,
    localPath,
    label,
    ref: parsed.ref,
    tempDir: localPath
  };
}

/**
 * Clean up a resolved source's temp directory (if any).
 */
export function cleanupSource(source: ResolvedSource): void {
  if (source.tempDir && fs.existsSync(source.tempDir)) {
    try {
      fs.rmSync(source.tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
}

/**
 * Check if an input looks like a remote source (GitHub URL).
 */
export function isRemoteSource(input: string): boolean {
  const trimmed = input.trim();
  return trimmed.startsWith("github://") || /^https?:\/\/github\.com\//i.test(trimmed);
}
