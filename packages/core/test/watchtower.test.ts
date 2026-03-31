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

/** Default process-discipline task IDs in the new default profile. */
const DEFAULT_TASK_IDS = [
  "functional_multidomain_001",
  "functional_investigation_001",
  "functional_scope_001",
  "functional_scope_002",
  "functional_handoff_001",
  "functional_handoff_002",
  "functional_handoff_003",
  "functional_routing_001"
];

/** Library-quality task IDs. */
const LIBRARY_QUALITY_TASK_IDS = [
  "libqual_usage_001",
  "libqual_discovery_001",
  "libqual_boundary_001",
  "libqual_boundary_002",
  "libqual_review_001",
  "libqual_review_002",
  "libqual_handoff_001",
  "libqual_handoff_002"
];

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

/** Build a mapping where all provided task IDs get the same left/right scores. */
function uniformMapping(
  taskIds: string[],
  left: number,
  right: number,
  opts?: { leftFailedTrials?: number; rightFailedTrials?: number }
): Record<string, { left: number; right: number; leftFailedTrials?: number; rightFailedTrials?: number }> {
  const mapping: Record<string, { left: number; right: number; leftFailedTrials?: number; rightFailedTrials?: number }> = {};
  for (const id of taskIds) {
    mapping[id] = { left, right, ...opts };
  }
  return mapping;
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
      executor: createMappedExecutor(uniformMapping(DEFAULT_TASK_IDS, 0.25, 1))
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
      executor: createMappedExecutor(uniformMapping(DEFAULT_TASK_IDS, 0.25, 1))
    });

    expect(run.profile_id).toBe("default");
    expect(run.selected_task_ids).toEqual(DEFAULT_TASK_IDS);
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
      executor: createMappedExecutor(uniformMapping(DEFAULT_TASK_IDS, 0.5, 0.5))
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
      executor: createMappedExecutor(
        uniformMapping(DEFAULT_TASK_IDS, 0.25, 1, { leftFailedTrials: 1, rightFailedTrials: 1 })
      )
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
      executor: createMappedExecutor(uniformMapping(DEFAULT_TASK_IDS, 0.25, 1))
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
      executor: createMappedExecutor(
        uniformMapping(DEFAULT_TASK_IDS, 0.25, 1, { leftFailedTrials: 2, rightFailedTrials: 2 })
      )
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
      executor: createMappedExecutor(uniformMapping(DEFAULT_TASK_IDS, 0.25, 1))
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
      executor: createMappedExecutor(uniformMapping(DEFAULT_TASK_IDS, 0.25, 1))
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
      executor: createMappedExecutor(uniformMapping(DEFAULT_TASK_IDS, 0.25, 1))
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

  it("lists all bundled benchmark profiles", () => {
    const profiles = listProfiles();
    const ids = profiles.map((profile) => profile.profile_id);
    expect(ids).toContain("default");
    expect(ids).toContain("library-quality");
    expect(ids).toContain("friction");
    expect(ids).toContain("grounded");
  });

  it("retrieves the default and named profiles", () => {
    expect(getBenchmarkProfile("default").profile_id).toBe("default");
    expect(getBenchmarkProfile("library-quality").profile_id).toBe("library-quality");
    expect(getBenchmarkProfile("friction").profile_id).toBe("friction");
    expect(getBenchmarkProfile("grounded").profile_id).toBe("grounded");
    expect(() => getBenchmarkProfile("nonexistent-profile")).toThrow(/Unknown Watchtower profile/);
  });

  it("runs the library-quality profile with legacy task IDs", async () => {
    const leftRoot = createSkillLibrary("lq-left", "weak");
    const rightRoot = createSkillLibrary("lq-right", "strong");
    const dataRoot = path.join(os.tmpdir(), `watchtower-data-${Date.now()}`);
    tempRoots.push(dataRoot);

    const run = await compareLibrariesRun({
      leftRootPath: leftRoot,
      rightRootPath: rightRoot,
      comparisonMode: "cross_library",
      allowlistedParentRoot: os.tmpdir(),
      dataRoot,
      profileId: "library-quality",
      executor: createMappedExecutor(uniformMapping(LIBRARY_QUALITY_TASK_IDS, 0.25, 1))
    });

    expect(run.profile_id).toBe("library-quality");
    expect(run.selected_task_ids).toEqual(LIBRARY_QUALITY_TASK_IDS);
    expect(run.winner).toBe("right");
  });

  it("runs the friction profile", async () => {
    const leftRoot = createSkillLibrary("friction-left", "weak");
    const rightRoot = createSkillLibrary("friction-right", "strong");
    const dataRoot = path.join(os.tmpdir(), `watchtower-data-${Date.now()}`);
    tempRoots.push(dataRoot);

    const frictionTaskIds = ["friction_email_001", "friction_commit_001", "friction_explain_001"];
    const run = await compareLibrariesRun({
      leftRootPath: leftRoot,
      rightRootPath: rightRoot,
      comparisonMode: "cross_library",
      allowlistedParentRoot: os.tmpdir(),
      dataRoot,
      profileId: "friction",
      executor: createMappedExecutor(uniformMapping(frictionTaskIds, 0.75, 0.75))
    });

    expect(run.profile_id).toBe("friction");
    expect(run.selected_task_ids).toEqual(frictionTaskIds);
  });

  it("runs the grounded verification profile", async () => {
    const leftRoot = createSkillLibrary("grounded-left", "weak");
    const rightRoot = createSkillLibrary("grounded-right", "strong");
    const dataRoot = path.join(os.tmpdir(), `watchtower-data-${Date.now()}`);
    tempRoots.push(dataRoot);

    const groundedTaskIds = [
      "grounded_logic_001",
      "grounded_causal_001",
      "grounded_debug_001",
      "grounded_review_001"
    ];
    const run = await compareLibrariesRun({
      leftRootPath: leftRoot,
      rightRootPath: rightRoot,
      comparisonMode: "cross_library",
      allowlistedParentRoot: os.tmpdir(),
      dataRoot,
      profileId: "grounded",
      executor: createMappedExecutor(uniformMapping(groundedTaskIds, 0.5, 1))
    });

    expect(run.profile_id).toBe("grounded");
    expect(run.selected_task_ids).toEqual(groundedTaskIds);
    expect(run.winner).toBe("right");
  });

  it("grounded profile tasks carry expected_answer for deterministic scoring", () => {
    const profile = getBenchmarkProfile("grounded");
    const answers = profile.tasks.map((t) => ({ id: t.task_id, answer: t.expected_answer, kind: t.evaluator_kind }));

    for (const { id, answer, kind } of answers) {
      expect(kind).toBe("deterministic");
      expect(answer).toBeDefined();
      expect(typeof answer).toBe("string");
      expect((answer as string).length).toBeGreaterThan(0);
    }

    // Verify specific expected answers
    const logic = profile.tasks.find((t) => t.task_id === "grounded_logic_001");
    expect(logic?.expected_answer).toBe("FALLACY");
    const review = profile.tasks.find((t) => t.task_id === "grounded_review_001");
    expect(review?.expected_answer).toBe("BUG_FOUND");
  });

  it("supports two-phase executor with perform and judge", async () => {
    const leftRoot = createSkillLibrary("twophase-left", "weak");
    const rightRoot = createSkillLibrary("twophase-right", "strong");
    const dataRoot = path.join(os.tmpdir(), `watchtower-data-${Date.now()}`);
    tempRoots.push(dataRoot);

    const twoPhaseExecutor: Executor = {
      version: "test-twophase-v1",
      async run(input) {
        // Fallback for tasks without rubric (should not be called for rubric tasks in two-phase)
        return { normalizedScore: 0.5, status: "valid", falsePositive: 0 };
      },
      async perform(input) {
        const text = input.sideId === "left" ? "weak output" : "strong output with evidence and structure";
        return { text, tokenCount: input.sideId === "left" ? 200 : 500 };
      },
      async judge(input) {
        // Always give higher score to the output with "evidence" (which is the right/strong side)
        const aHasEvidence = input.outputA.includes("evidence");
        return {
          aScore: aHasEvidence ? 0.9 : 0.3,
          bScore: aHasEvidence ? 0.3 : 0.9,
          reasoning: "Output with evidence and structure is better."
        };
      }
    };

    const run = await compareLibrariesRun({
      leftRootPath: leftRoot,
      rightRootPath: rightRoot,
      comparisonMode: "cross_library",
      allowlistedParentRoot: os.tmpdir(),
      dataRoot,
      executor: twoPhaseExecutor
    });

    expect(run.winner).toBe("right");
    // Verify two-phase trial results exist for both sides
    const leftTrials = run.task_trial_results.filter((r) => r.side_id === "left");
    const rightTrials = run.task_trial_results.filter((r) => r.side_id === "right");
    expect(leftTrials.length).toBeGreaterThan(0);
    expect(rightTrials.length).toBeGreaterThan(0);
    // Verify token counts are captured
    expect(leftTrials.some((r) => r.token_count != null)).toBe(true);
    expect(rightTrials.some((r) => r.token_count != null)).toBe(true);
  });
});
