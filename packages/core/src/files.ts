import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { minimatch } from "minimatch";

export type FileEntry = {
  relativePath: string;
  absolutePath: string;
  digest: string;
  size: number;
};

export function sha256Bytes(input: Buffer | string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function isUncPath(targetPath: string): boolean {
  return targetPath.startsWith("\\\\");
}

export function canonicalizePath(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  if (!fs.existsSync(resolved)) {
    return resolved;
  }
  return fs.realpathSync.native?.(resolved) ?? fs.realpathSync(resolved);
}

export function isDescendantPath(root: string, child: string): boolean {
  const relative = path.relative(root, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function loadText(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

export function walkFiles(rootDir: string, ignoreGlobs: string[] = []): FileEntry[] {
  const output: FileEntry[] = [];
  const stack = [rootDir];
  const canonicalRoot = canonicalizePath(rootDir);

  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = fs.readdirSync(current, { withFileTypes: true });

    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      const relativePath = path
        .relative(rootDir, absolutePath)
        .split(path.sep)
        .join("/");
      const ignored = ignoreGlobs.some((glob) => minimatch(relativePath, glob, { dot: true }));

      if (ignored) {
        continue;
      }

      const stat = fs.lstatSync(absolutePath);
      const realPath = stat.isSymbolicLink() ? canonicalizePath(absolutePath) : absolutePath;
      if (stat.isSymbolicLink()) {
        if (realPath !== canonicalRoot && !isDescendantPath(canonicalRoot, realPath)) {
          throw new Error(`Symlink escapes root: ${absolutePath}`);
        }
      }

      const resolvedStat = stat.isSymbolicLink() ? fs.statSync(absolutePath) : stat;

      if (resolvedStat.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }

      if (resolvedStat.isFile()) {
        const bytes = fs.readFileSync(absolutePath);
        output.push({
          relativePath,
          absolutePath,
          digest: sha256Bytes(bytes),
          size: bytes.byteLength
        });
      }
    }
  }

  return output.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export function hashFileEntries(entries: FileEntry[]): string {
  const payload = entries.map((entry) => `${entry.relativePath}:${entry.digest}:${entry.size}`).join("\n");
  return sha256Bytes(payload);
}

export function copyEntriesToDir(entries: FileEntry[], rootDir: string, destDir: string): void {
  ensureDir(destDir);
  for (const entry of entries) {
    const dest = path.join(destDir, entry.relativePath);
    ensureDir(path.dirname(dest));
    fs.copyFileSync(entry.absolutePath, dest);
  }
}

export function writeJson(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
