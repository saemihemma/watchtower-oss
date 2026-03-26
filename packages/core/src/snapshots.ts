import fs from "node:fs";
import path from "node:path";
import {
  canonicalizePath,
  copyEntriesToDir,
  ensureDir,
  hashFileEntries,
  isDescendantPath,
  isUncPath,
  walkFiles,
  writeJson
} from "./files.js";

export type SnapshotOptions = {
  rootPath: string;
  allowlistedParentRoot: string;
  ignoreGlobs: string[];
  destRoot: string;
};

export type SnapshotResult = {
  rootPath: string;
  treeHash: string;
  snapshotDir: string;
  files: { relativePath: string; digest: string }[];
};

export function validateWorkspacePath(rootPath: string, allowlistedParentRoot: string): string {
  if (!path.isAbsolute(rootPath)) {
    throw new Error("Workspace path must be absolute.");
  }
  if (isUncPath(rootPath)) {
    throw new Error("UNC/network workspace paths are not allowed.");
  }

  const resolvedRoot = path.resolve(rootPath);
  if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) {
    throw new Error("Workspace path does not exist or is not a directory.");
  }

  const canonicalRoot = canonicalizePath(resolvedRoot);
  const canonicalAllowlist = canonicalizePath(allowlistedParentRoot);

  if (canonicalRoot !== canonicalAllowlist && !isDescendantPath(canonicalAllowlist, canonicalRoot)) {
    throw new Error("Workspace path is outside the allowlisted parent root.");
  }
  return canonicalRoot;
}

export function createSnapshot(options: SnapshotOptions): SnapshotResult {
  const canonicalRoot = validateWorkspacePath(options.rootPath, options.allowlistedParentRoot);
  const entries = walkFiles(canonicalRoot, options.ignoreGlobs);
  const treeHash = hashFileEntries(entries);
  const snapshotDir = path.join(options.destRoot, treeHash);

  if (!fs.existsSync(path.join(snapshotDir, "files"))) {
    ensureDir(snapshotDir);
    copyEntriesToDir(entries, canonicalRoot, path.join(snapshotDir, "files"));
    writeJson(path.join(snapshotDir, "snapshot-manifest.json"), {
      rootPath: canonicalRoot,
      treeHash,
      createdAt: new Date().toISOString(),
      files: entries.map((entry) => ({
        relativePath: entry.relativePath,
        digest: entry.digest,
        size: entry.size
      }))
    });
  }

  return {
    rootPath: canonicalRoot,
    treeHash,
    snapshotDir,
    files: entries.map((entry) => ({
      relativePath: entry.relativePath,
      digest: entry.digest
    }))
  };
}

