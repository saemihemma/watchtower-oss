import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Executor,
  compareLibrariesRun,
  getBenchmarkProfile,
  listProfiles,
  loadRun,
  replaceFromRun,
  showRun,
  validateWorkspacePath
} from "../src/index.js";

const tempRoots: string[] = [];

function writeFile(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

function createSkillLibrary(label: string, variant: "strong" | "weak" = "strong"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  tempRoots.push(root);

  const routingGuide =
    variant === "strong"
      ? [
          "# Routing Guide",
          "",
          "## What It Is",
          "Helps users discover the best skill and when to use it.",
          "",
          "## What It Is NOT",
          "Not a vague catch-all.",
          "",
          "## Use When",
          "Use when you need a clear route or comparison point.",
          "",
          "## Do NOT Use When",
          "Do not use it when another skill already fits better.",
          "",
          "best for",
          "discover",
          "overlap",
          "next action"
        ].join("\n")
      : ["# Routing Guide", "", "General help.", "Some advice."].join("\n");

  writeFile(path.join(root, "routing-guide", "SKILL.md"), routingGuide);
  writeFile(
    path.join(root, "boundary-guide", "SKILL.md"),
    variant === "strong"
      ? "# Boundary Guide\n\nWhat It Is\nWhat It Is NOT\nscope\nboundaries\noverlap\nresponsibilities\n"
      : "# Boundary Guide\n\nIdeas.\n"
  );
  writeFile(
    path.join(root, "review-guide", "SKILL.md"),
    variant === "strong"
      ? "# Review Guide\n\nevidence\nverify\nacceptance\nexamples\nsteps\n"
      : "# Review Guide\n\nCode thoughts.\n"
  );
  writeFile(
    path.join(root, "handoff-guide", "SKILL.md"),
    variant === "strong"
      ? "# Handoff Guide\n\nhandoff\nnext action\noutput\ncontext\ndeliverable\n"
      : "# Handoff Guide\n\nNotes.\n"
  );

  return root;
}

function createNoSkillRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchtower-noskill-"));
  tempRoots.push(root);
  writeFile(path.join(root, "README.md"), "No skill files here.");
  return root;
}

function createMappedExecutor(
  mapping: Record<string, { left: number; right: number; leftFailedTrials?: number; rightFailedTrials?: number }>
): Executor {
  return {
    version: "test-mapped-v2",
    async run(input) {
      const entry = mapping[input.task.task_id] ?? { left: 0.5, right: 0.5 };
      const failedTrials = input.sideId === "left" ? entry.leftFailedTrials ?? 0 : entry.rightFailedTrials ?? 0;
      if (input.trialIndex <= failedTrials) {
        return {
          normalizedScore: null,
          status: "failed",
          falsePositive: 0,
          reason: "synthetic_failure"
        };
      }
      const score = input.sideId === "left" ? entry.left : entry.right;
      return {
        normalizedScore: score,
        falsePositive: 0,
        status: "valid"
      };
    }
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("watchtower benchmark core", () => {
  it("compares two markdown skill libraries with the default profile and stores run artifacts", async () => {
    const leftRoot = createSkillLibrary("left-lib", "weak");
    const rightRoot = createSkillLibrary("right-lib", "strong");
    const dataRoot = path.join(os.tmpdir(), `watchtower-data-${Date.now()}`);
    tempRoots.push(dataRoot);

    const run = await compareLibrariesRun({
      leftRootPath: leftRoot,
      rightRootPath: rightRoot,
      comparisonMode: "cross_library",
      allowlistedParentRoot: os.tmpdir(),
      dataRoot,
      executor: createMappedExecutor({
        default_usage_001: { left: 0.25, right: 1 },
        default_discovery_001: { left: 0.25, right: 1 },
        default_boundary_001: { left: 0.25, right: 1 },
        default_boundary_002: { left: 0.25, right: 1 },
        default_review_001: { left: 0.25, right: 1 },
        default_review_002: { left: 0.25, right: 1 },
        default_handoff_001: { left: 0.25, right: 1 },
        default_handoff_002: { left: 0.25, right: 1 }
      })
    });

    expect(run.profile_id).toBe("default");
    expect(run.winner).toBe("right");
    expect(run.scorecard.right_score).toBeGreaterThan(run.scorecard.left_score);
    expect(run.report_path).toBeTruthy();
    expect(run.run_path).toBeTruthy();
    expect(fs.existsSync(run.report_path as string)).toBe(true);
    expect(fs.existsSync(run.run_path as string)).toBe(true);
  });

  it("uses the default bundled profile task pack", async () => {
    const leftRoot = createSkillLibrary("profile-left", "weak");
    const rightRoot = createSkillLibrary("profile-right", "strong");
    const dataRoot = path.join(os.tmpdir(), `watchtower-data-${Date.now()}`);
    tempRoots.push(dataRoot);

    const run = await compareLibrariesRun({
      leftRootPath: leftRoot,
      rightRootPath: rightRoot,
      comparisonMode: "cross_library",
      allowlistedParentRoot: os.tmpdir(),
      dataRoot,
      executor: createMappedExecutor({
        default_usage_001: { left: 0.25, right: 1 },
        default_discovery_001: { left: 0.25, right: 1 },
        default_boundary_001: { left: 0.25, right: 1 },
        default_boundary_002: { left: 0.25, right: 1 },
        default_review_001: { left: 0.25, right: 1 },
        default_review_002: { left: 0.25, right: 1 },
        default_handoff_001: { left: 0.25, right: 1 },
        default_handoff_002: { left: 0.25, right: 1 },
        arch_structure_001: { left: 0.25, right: 1 },
        arch_composition_001: { left: 0.25, right: 1 },
        hygiene_bloat_001: { left: 0.25, right: 1 },
        hygiene_replace_001: { left: 0.25, right: 1 },
        constraint_ambiguity_001: { left: 0.25, right: 1 },
        constraint_partial_001: { left: 0.25, right: 1 }
      })
    });

    expect(run.profile_id).toBe("default");
    expect(run.selected_task_ids).toEqual([
      "default_usage_001",
      "default_discovery_001",
      "default_boundary_001",
      "default_boundary_002",
      "default_review_001",
      "default_review_002",
      "default_handoff_001",
      "default_handoff_002",
      "arch_structure_001",
      "arch_composition_001",
      "hygiene_bloat_001",
      "hygiene_replace_001",
      "constraint_ambiguity_001",
      "constraint_partial_001"
    ]);
  });

  it("returns too_close_to_call when the score delta is below threshold", async () => {
    const leftRoot = createSkillLibrary("close-left", "strong");
    const rightRoot = createSkillLibrary("close-right", "strong");
    const dataRoot = path.join(os.tmpdir(), `watchtower-data-${Date.now()}`);
    tempRoots.push(dataRoot);

    const run = await compareLibrariesRun({
      leftRootPath: leftRoot,
      rightRootPath: rightRoot,
      comparisonMode: "cross_library",
      allowlistedParentRoot: os.tmpdir(),
      dataRoot,
      executor: createMappedExecutor({
        default_usage_001: { left: 0.5, right: 0.5 },
        default_discovery_001: { left: 0.5, right: 0.5 },
        default_boundary_001: { left: 0.5, right: 0.5 },
        default_boundary_002: { left: 0.5, right: 0.5 },
        default_review_001: { left: 0.5, right: 0.5 },
        default_review_002: { left: 0.5, right: 0.5 },
        default_handoff_001: { left: 0.5, right: 0.5 },
        default_handoff_002: { left: 0.5, right: 0.5 }
      })
    });

    expect(run.winner).toBe("too_close_to_call");
    expect(run.recommended_action).toBe("rerun_with_narrower_change");
  });

  it("emits a Devil's Advocate caution when the run is only medium confidence", async () => {
    const leftRoot = createSkillLibrary("caution-left", "weak");
    const rightRoot = createSkillLibrary("caution-right", "strong");
    const dataRoot = path.join(os.tmpdir(), `watchtower-data-${Date.now()}`);
    tempRoots.push(dataRoot);

    const run = await compareLibrariesRun({
      leftRootPath: leftRoot,
      rightRootPath: rightRoot,
      comparisonMode: "same_library",
      allowlistedParentRoot: os.tmpdir(),
      dataRoot,
      executor: createMappedExecutor({
        default_usage_001: { left: 0.25, right: 1, leftFailedTrials: 1, rightFailedTrials: 1 },
        default_discovery_001: { left: 0.25, right: 1, leftFailedTrials: 1, rightFailedTrials: 1 },
        default_boundary_001: { left: 0.25, right: 1, leftFailedTrials: 1, rightFailedTrials: 1 },
        default_boundary_002: { left: 0.25, right: 1, leftFailedTrials: 1, rightFailedTrials: 1 },
        default_review_001: { left: 0.25, right: 1, leftFailedTrials: 1, rightFailedTrials: 1 },
        default_review_002: { left: 0.25, right: 1, leftFailedTrials: 1, rightFailedTrials: 1 },
        default_handoff_001: { left: 0.25, right: 1, leftFailedTrials: 1, rightFailedTrials: 1 },
        default_handoff_002: { left: 0.25, right: 1, leftFailedTrials: 1, rightFailedTrials: 1 }
      })
    });

    expect(run.scorecard.confidence).toBe("medium");
    expect(run.devils_advocate.verdict).toBe("caution");
    expect(run.devils_advocate.arguments[0]).toContain("medium");
  });

  it("blocks replace for cross-library runs", async () => {
    const leftRoot = createSkillLibrary("cross-left", "weak");
    const rightRoot = createSkillLibrary("cross-right", "strong");
    const dataRoot = path.join(os.tmpdir(), `watchtower-data-${Date.now()}`);
    tempRoots.push(dataRoot);

    const run = await compareLibrariesRun({
      leftRootPath: leftRoot,
      rightRootPath: rightRoot,
      comparisonMode: "cross_library",
      allowlistedParentRoot: os.tmpdir(),
      dataRoot,
      executor: createMappedExecutor({
        default_usage_001: { left: 0.25, right: 1 },
        default_discovery_001: { left: 0.25, right: 1 },
        default_boundary_001: { left: 0.25, right: 1 },
        default_boundary_002: { left: 0.25, right: 1 },
        default_review_001: { left: 0.25, right: 1 },
        default_review_002: { left: 0.25, right: 1 },
        default_handoff_001: { left: 0.25, right: 1 },
        default_handoff_002: { left: 0.25, right: 1 }
      })
    });

    expect(() => replaceFromRun(dataRoot, run.run_id, "left", true)).toThrow(/cross-library comparisons/);
  });

  it("blocks replace for non-eligible same-library runs", async () => {
    const leftRoot = createSkillLibrary("block-left", "weak");
    const rightRoot = createSkillLibrary("block-right", "strong");
    const dataRoot = path.join(os.tmpdir(), `watchtower-data-${Date.now()}`);
    tempRoots.push(dataRoot);

    const run = await compareLibrariesRun({
      leftRootPath: leftRoot,
      rightRootPath: rightRoot,
      comparisonMode: "same_library",
      allowlistedParentRoot: os.tmpdir(),
      dataRoot,
      executor: createMappedExecutor({
        default_usage_001: { left: 0.25, right: 1, leftFailedTrials: 2, rightFailedTrials: 2 },
        default_discovery_001: { left: 0.25, right: 1, leftFailedTrials: 2, rightFailedTrials: 2 },
        default_boundary_001: { left: 0.25, right: 1, leftFailedTrials: 2, rightFailedTrials: 2 },
        default_boundary_002: { left: 0.25, right: 1, leftFailedTrials: 2, rightFailedTrials: 2 },
        default_review_001: { left: 0.25, right: 1, leftFailedTrials: 2, rightFailedTrials: 2 },
        default_review_002: { left: 0.25, right: 1, leftFailedTrials: 2, rightFailedTrials: 2 },
        default_handoff_001: { left: 0.25, right: 1, leftFailedTrials: 2, rightFailedTrials: 2 },
        default_handoff_002: { left: 0.25, right: 1, leftFailedTrials: 2, rightFailedTrials: 2 }
      })
    });

    expect(run.replace_eligible).toBe(false);
    expect(() => replaceFromRun(dataRoot, run.run_id, "left", true)).toThrow(/not replace-eligible/);
  });

  it("blocks replace when the losing side is marked remote or ephemeral", async () => {
    const leftRoot = createSkillLibrary("remote-left", "weak");
    const rightRoot = createSkillLibrary("remote-right", "strong");
    const dataRoot = path.join(os.tmpdir(), `watchtower-data-${Date.now()}`);
    tempRoots.push(dataRoot);

    const run = await compareLibrariesRun({
      leftRootPath: leftRoot,
      rightRootPath: rightRoot,
      comparisonMode: "same_library",
      allowlistedParentRoot: os.tmpdir(),
      dataRoot,
      executor: createMappedExecutor({
        default_usage_001: { left: 0.25, right: 1 },
        default_discovery_001: { left: 0.25, right: 1 },
        default_boundary_001: { left: 0.25, right: 1 },
        default_boundary_002: { left: 0.25, right: 1 },
        default_review_001: { left: 0.25, right: 1 },
        default_review_002: { left: 0.25, right: 1 },
        default_handoff_001: { left: 0.25, right: 1 },
        default_handoff_002: { left: 0.25, right: 1 }
      })
    });

    const runPath = path.join(dataRoot, "runs", `${run.run_id}.json`);
    const persisted = JSON.parse(fs.readFileSync(runPath, "utf8"));
    persisted.left_side.source_kind = "github";
    persisted.left_side.replaceable = false;
    persisted.left_side.root_path = "github://example/reference-library";
    fs.writeFileSync(runPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");

    expect(() => replaceFromRun(dataRoot, run.run_id, "left", true)).toThrow(/remote or ephemeral/);
  });

  it("allows archive-first whole-root replace for decisive same-library runs", async () => {
    const leftRoot = createSkillLibrary("replace-left", "weak");
    const rightRoot = createSkillLibrary("replace-right", "strong");
    writeFile(path.join(leftRoot, ".git", "HEAD"), "ref: refs/heads/main\n");

    const dataRoot = path.join(os.tmpdir(), `watchtower-data-${Date.now()}`);
    tempRoots.push(dataRoot);

    const run = await compareLibrariesRun({
      leftRootPath: leftRoot,
      rightRootPath: rightRoot,
      comparisonMode: "same_library",
      allowlistedParentRoot: os.tmpdir(),
      dataRoot,
      executor: createMappedExecutor({
        default_usage_001: { left: 0.25, right: 1 },
        default_discovery_001: { left: 0.25, right: 1 },
        default_boundary_001: { left: 0.25, right: 1 },
        default_boundary_002: { left: 0.25, right: 1 },
        default_review_001: { left: 0.25, right: 1 },
        default_review_002: { left: 0.25, right: 1 },
        default_handoff_001: { left: 0.25, right: 1 },
        default_handoff_002: { left: 0.25, right: 1 }
      })
    });

    const result = replaceFromRun(dataRoot, run.run_id, "left", true);
    const replacedSkill = fs.readFileSync(path.join(leftRoot, "routing-guide", "SKILL.md"), "utf8");

    expect(result.target_side).toBe("left");
    expect(fs.existsSync(result.archive_dir)).toBe(true);
    expect(replacedSkill).toContain("## What It Is");
    expect(fs.existsSync(path.join(leftRoot, ".git", "HEAD"))).toBe(true);
  });

  it("re-opens a stored run through show()", async () => {
    const leftRoot = createSkillLibrary("show-left", "weak");
    const rightRoot = createSkillLibrary("show-right", "strong");
    const dataRoot = path.join(os.tmpdir(), `watchtower-data-${Date.now()}`);
    tempRoots.push(dataRoot);

    const run = await compareLibrariesRun({
      leftRootPath: leftRoot,
      rightRootPath: rightRoot,
      comparisonMode: "cross_library",
      allowlistedParentRoot: os.tmpdir(),
      dataRoot,
      executor: createMappedExecutor({
        default_usage_001: { left: 0.25, right: 1 },
        default_discovery_001: { left: 0.25, right: 1 },
        default_boundary_001: { left: 0.25, right: 1 },
        default_boundary_002: { left: 0.25, right: 1 },
        default_review_001: { left: 0.25, right: 1 },
        default_review_002: { left: 0.25, right: 1 },
        default_handoff_001: { left: 0.25, right: 1 },
        default_handoff_002: { left: 0.25, right: 1 }
      })
    });

    const shown = showRun(dataRoot, run.run_id);
    const loaded = loadRun(dataRoot, run.run_id);

    expect(shown.reportText).toContain("Watchtower Benchmark Run");
    expect(loaded.run_id).toBe(run.run_id);
  });

  it("validates workspace paths and rejects roots with no SKILL.md", async () => {
    const validRoot = createSkillLibrary("valid-root", "strong");
    const invalidRoot = createNoSkillRoot();
    const dataRoot = path.join(os.tmpdir(), `watchtower-data-${Date.now()}`);
    tempRoots.push(dataRoot);

    expect(validateWorkspacePath(validRoot, os.tmpdir()).toLowerCase()).toContain(path.basename(validRoot).toLowerCase());
    expect(() => validateWorkspacePath("\\\\server\\share", os.tmpdir())).toThrow(
      process.platform === "win32" ? /UNC\/network workspace paths/ : /Workspace path must be absolute/
    );

    await expect(
      compareLibrariesRun({
        leftRootPath: validRoot,
        rightRootPath: invalidRoot,
        comparisonMode: "cross_library",
        allowlistedParentRoot: os.tmpdir(),
        dataRoot,
        executor: createMappedExecutor({})
      })
    ).rejects.toThrow(/No SKILL.md files were found/);
  });

  it("lists the bundled benchmark profiles", () => {
    const profiles = listProfiles();
    expect(profiles.map((profile) => profile.profile_id)).toEqual(["default"]);
  });

  it("keeps only the default profile available", () => {
    expect(getBenchmarkProfile("default").profile_id).toBe("default");
    expect(() => getBenchmarkProfile("specialized-profile")).toThrow(/Unknown Watchtower profile/);
  });
});
