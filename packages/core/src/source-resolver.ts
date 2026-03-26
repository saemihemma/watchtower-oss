import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SourceKind } from "./schemas.js";

export type ParsedSource = {
  kind: SourceKind;
  owner?: string;
  repo?: string;
  ref?: string;
  localPath?: string;
  originalInput: string;
  sourceId?: string;
};

export type ResolvedSource = {
  kind: SourceKind;
  originalInput: string;
  localPath: string;
  label: string;
  sourceId: string;
  replaceable: boolean;
  ref?: string;
  tempDir?: string;
};

export function parseSourceInput(input: string): ParsedSource {
  const trimmed = input.trim();

  if (trimmed.startsWith("watchtower://")) {
    throw new Error(
      `Unsupported Watchtower source alias: ${trimmed}. Use a local path, github://owner/repo, or https://github.com/owner/repo.`
    );
  }

  if (trimmed.startsWith("github://")) {
    return parseGithubProtocol(trimmed);
  }

  if (/^https?:\/\/github\.com\//i.test(trimmed)) {
    return parseGithubHttpsUrl(trimmed);
  }

  return {
    kind: "local",
    localPath: trimmed,
    originalInput: trimmed
  };
}

function buildGithubSourceId(owner: string, repo: string, ref?: string): string {
  return `github://${owner}/${repo}${ref ? `@${ref}` : ""}`;
}

function parseGithubProtocol(input: string): ParsedSource {
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

  const normalizedRepo = repo.replace(/\.git$/, "");
  return {
    kind: "github",
    owner,
    repo: normalizedRepo,
    ref: ref || undefined,
    originalInput: input,
    sourceId: buildGithubSourceId(owner, normalizedRepo, ref || undefined)
  };
}

function parseGithubHttpsUrl(input: string): ParsedSource {
  const url = new URL(input);
  const segments = url.pathname.replace(/^\//, "").replace(/\.git$/, "").split("/");

  const owner = segments[0];
  const repo = segments[1];
  if (!owner || !repo) {
    throw new Error(`Invalid GitHub URL: ${input}. Expected https://github.com/owner/repo`);
  }

  let ref: string | undefined;
  if (segments[2] === "tree" && segments.length > 3) {
    ref = segments.slice(3).join("/");
  }

  return {
    kind: "github",
    owner,
    repo,
    ref: ref || undefined,
    originalInput: input,
    sourceId: buildGithubSourceId(owner, repo, ref || undefined)
  };
}

function cloneGitHub(parsed: ParsedSource, tempRoot: string): string {
  const { owner, repo, ref } = parsed;
  if (!owner || !repo) {
    throw new Error("Cannot clone: missing owner or repo");
  }

  const destDir = fs.mkdtempSync(path.join(tempRoot, `watchtower-github-${owner}-${repo}-`));

  const cloneUrl = `https://github.com/${owner}/${repo}.git`;
  const args: string[] = ["clone", "--depth", "1"];

  if (ref) {
    args.push("--branch", ref);
  }

  args.push(cloneUrl, destDir);

  const result = childProcess.spawnSync("git", args, {
    encoding: "utf8",
    timeout: 120_000,
    stdio: ["ignore", "pipe", "pipe"]
  });

  if (result.status !== 0) {
    if (ref && result.stderr?.includes("not found")) {
      return cloneGitHubAtCommit(owner, repo, ref, destDir);
    }

    fs.rmSync(destDir, { recursive: true, force: true });
    const stderr = (result.stderr ?? "").trim().slice(0, 500);
    throw new Error(
      `Failed to clone ${cloneUrl}${ref ? ` (ref: ${ref})` : ""}. ` +
        `Exit code ${result.status}. ${stderr}\n` +
        "Check that the repository exists, is public (or you have git credentials configured), and the branch/tag exists."
    );
  }

  return destDir;
}

function cloneGitHubAtCommit(owner: string, repo: string, sha: string, destDir: string): string {
  const cloneUrl = `https://github.com/${owner}/${repo}.git`;

  if (fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true, force: true });
  }

  fs.mkdirSync(destDir, { recursive: true });

  const init = childProcess.spawnSync("git", ["init"], {
    cwd: destDir,
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (init.status !== 0) {
    throw new Error(`git init failed: ${init.stderr}`);
  }

  const addRemote = childProcess.spawnSync("git", ["remote", "add", "origin", cloneUrl], {
    cwd: destDir,
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (addRemote.status !== 0) {
    throw new Error(`git remote add failed: ${addRemote.stderr}`);
  }

  const fetch = childProcess.spawnSync("git", ["fetch", "--depth", "1", "origin", sha], {
    cwd: destDir,
    encoding: "utf8",
    timeout: 120_000,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (fetch.status !== 0) {
    fs.rmSync(destDir, { recursive: true, force: true });
    throw new Error(`Failed to fetch commit ${sha} from ${cloneUrl}. ${(fetch.stderr ?? "").slice(0, 300)}`);
  }

  const checkout = childProcess.spawnSync("git", ["checkout", "FETCH_HEAD"], {
    cwd: destDir,
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (checkout.status !== 0) {
    throw new Error(`Failed to checkout ${sha}: ${(checkout.stderr ?? "").slice(0, 300)}`);
  }

  return destDir;
}

export function resolveSource(input: string, tempRoot?: string): ResolvedSource {
  const parsed = parseSourceInput(input);

  if (parsed.kind === "local") {
    const baseDir = process.env.WATCHTOWER_CALLER_CWD ?? process.env.INIT_CWD ?? process.cwd();
    const localPath = path.resolve(baseDir, parsed.localPath!);
    const label = path.basename(localPath);
    return {
      kind: "local",
      originalInput: input,
      localPath,
      label,
      sourceId: localPath,
      replaceable: true
    };
  }

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
    sourceId: parsed.sourceId ?? buildGithubSourceId(parsed.owner!, parsed.repo!, parsed.ref),
    replaceable: false,
    ref: parsed.ref,
    tempDir: localPath
  };
}

export function cleanupSource(source: ResolvedSource): void {
  if (source.tempDir && fs.existsSync(source.tempDir)) {
    try {
      fs.rmSync(source.tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
}

export function isRemoteSource(input: string): boolean {
  const trimmed = input.trim();
  return trimmed.startsWith("github://") || /^https?:\/\/github\.com\//i.test(trimmed);
}
