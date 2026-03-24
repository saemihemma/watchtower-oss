import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Executor,
  compareLibrariesRun,
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

  const leadProducer =
    variant === "strong"
      ? [
          "# Lead Producer",
          "",
          "## What It Is",
          "Routes work to the smallest sufficient team.",
          "",
          "## What It Is NOT",
          "Not a specialist role.",
          "",
          "## Use When",
          "Use when orchestration and stress testing matter.",
          "",
          "## Do NOT Use When",
          "Do not use it for narrow single-owner work.",
          "",
          "Devil's Advocate",
          "Acceptance",
          "open questions",
          "next action"
        ].join("\n")
      : ["# Lead Producer", "", "General help.", "Some advice."].join("\n");

  writeFile(path.join(root, "lead-producer", "SKILL.md"), leadProducer);
  writeFile(
    path.join(root, "team-product-team", "SKILL.md"),
    variant === "strong"
      ? "# Product Team\n\nWhat It Is\nWhat It Is NOT\nscope\nfeasibility\ntrade-off\nnext action\n"
      : "# Product Team\n\nIdeas.\n"
  );
  writeFile(
    path.join(root, "team-dev-team", "SKILL.md"),
    variant === "strong"
      ? "# Dev Team\n\narchitecture\ncode quality\ntests\nverification\nreview\n"
      : "# Dev Team\n\nCode thoughts.\n"
  );
  writeFile(
    path.join(root, "workflow-issue-triage", "SKILL.md"),
    variant === "strong"
      ? "# Issue Triage\n\nhandoff\nnext steps\nowner\ncontext\n"
      : "# Issue Triage\n\nNotes.\n"
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

  it("uses bundled profiles and changes the selected task pack", async () => {
    const leftRoot = createSkillLibrary("profile-left", "weak");
    const rightRoot = createSkillLibrary("profile-right", "strong");
    const dataRoot = path.join(os.tmpdir(), `watchtower-data-${Date.now()}`);
    tempRoots.push(dataRoot);

    const run = await compareLibrariesRun({
      leftRootPath: leftRoot,
      rightRootPath: rightRoot,
      profileId: "lead-producer",
      comparisonMode: "cross_library",
      allowlistedParentRoot: os.tmpdir(),
      dataRoot,
      executor: createMappedExecutor({
        lp_route_001: { left: 0.25, right: 1 },
        lp_boundary_001: { left: 0.25, right: 1 },
        lp_accept_001: { left: 0.25, right: 1 },
        lp_handoff_001: { left: 0.25, right: 1 }
      })
    });

    expect(run.profile_id).toBe("lead-producer");
    expect(run.selected_task_ids).toEqual(["lp_route_001", "lp_boundary_001", "lp_accept_001", "lp_handoff_001"]);
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
      profileId: "lead-producer",
      comparisonMode: "same_library",
      allowlistedParentRoot: os.tmpdir(),
      dataRoot,
      executor: createMappedExecutor({
        lp_route_001: { left: 0.25, right: 1, leftFailedTrials: 1, rightFailedTrials: 1 },
        lp_boundary_001: { left: 0.25, right: 1, leftFailedTrials: 1, rightFailedTrials: 1 },
        lp_accept_001: { left: 0.25, right: 1, leftFailedTrials: 1, rightFailedTrials: 0 },
        lp_handoff_001: { left: 0.25, right: 1, leftFailedTrials: 0, rightFailedTrials: 0 }
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
      profileId: "lead-producer",
      comparisonMode: "same_library",
      allowlistedParentRoot: os.tmpdir(),
      dataRoot,
      executor: createMappedExecutor({
        lp_route_001: { left: 0.25, right: 1, leftFailedTrials: 2, rightFailedTrials: 2 },
        lp_boundary_001: { left: 0.25, right: 1, leftFailedTrials: 2, rightFailedTrials: 2 },
        lp_accept_001: { left: 0.25, right: 1, leftFailedTrials: 2, rightFailedTrials: 2 },
        lp_handoff_001: { left: 0.25, right: 1, leftFailedTrials: 2, rightFailedTrials: 2 }
      })
    });

    expect(run.replace_eligible).toBe(false);
    expect(() => replaceFromRun(dataRoot, run.run_id, "left", true)).toThrow(/not replace-eligible/);
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
      profileId: "lead-producer",
      comparisonMode: "same_library",
      allowlistedParentRoot: os.tmpdir(),
      dataRoot,
      executor: createMappedExecutor({
        lp_route_001: { left: 0.25, right: 1 },
        lp_boundary_001: { left: 0.25, right: 1 },
        lp_accept_001: { left: 0.25, right: 1 },
        lp_handoff_001: { left: 0.25, right: 1 }
      })
    });

    const result = replaceFromRun(dataRoot, run.run_id, "left", true);
    const replacedSkill = fs.readFileSync(path.join(leftRoot, "lead-producer", "SKILL.md"), "utf8");

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
    expect(() => validateWorkspacePath("\\\\server\\share", os.tmpdir())).toThrow(/UNC\/network workspace paths/);

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
    expect(profiles.map((profile) => profile.profile_id)).toEqual([
      "default",
      "lead-producer",
      "team-product-team",
      "team-dev-team",
      "workflow-issue-triage"
    ]);
  });
});
