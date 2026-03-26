import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  validateExternalProfile,
  buildProfileFromExternal,
  loadProfileFromFile,
  subsetProfileByCategories,
  registerMockCues,
  lookupMockCues,
  registerMockCuesFromProfile,
  type ExternalProfileDefinition
} from "../src/index.js";
import { getBenchmarkProfile } from "../src/index.js";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("validateExternalProfile", () => {
  it("returns no errors for a valid profile", () => {
    const valid: ExternalProfileDefinition = {
      profile_id: "game-design",
      label: "Game Design",
      description: "Benchmarks for game design skill libraries.",
      category_weights: { gameplay_depth: 40, balance: 30, clarity: 30 },
      tasks: [
        {
          task_id: "gd_depth_001",
          category: "gameplay_depth",
          prompt_text: "Does the skill library handle emergent gameplay?"
        },
        {
          task_id: "gd_balance_001",
          category: "balance",
          prompt_text: "Does the library address balance constraints?"
        }
      ]
    };
    expect(validateExternalProfile(valid)).toEqual([]);
  });

  it("rejects non-object input", () => {
    const errors = validateExternalProfile("not an object");
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("root");
  });

  it("rejects missing required fields", () => {
    const errors = validateExternalProfile({ category_weights: {}, tasks: [] });
    expect(errors.some((e) => e.field === "profile_id")).toBe(true);
    expect(errors.some((e) => e.field === "label")).toBe(true);
    expect(errors.some((e) => e.field === "description")).toBe(true);
  });

  it("rejects empty tasks without extends_default", () => {
    const errors = validateExternalProfile({
      profile_id: "empty",
      label: "Empty",
      description: "No tasks",
      category_weights: { foo: 10 },
      tasks: []
    });
    expect(errors.some((e) => e.field === "tasks")).toBe(true);
  });

  it("allows empty tasks with extends_default", () => {
    const errors = validateExternalProfile({
      profile_id: "ext",
      label: "Extended",
      description: "Extends default",
      extends_default: true,
      category_weights: { routing_accuracy: 50 },
      tasks: []
    });
    expect(errors).toEqual([]);
  });

  it("catches duplicate task IDs", () => {
    const errors = validateExternalProfile({
      profile_id: "dup",
      label: "Dup",
      description: "Dup",
      category_weights: { foo: 10 },
      tasks: [
        { task_id: "same", category: "foo", prompt_text: "A" },
        { task_id: "same", category: "foo", prompt_text: "B" }
      ]
    });
    expect(errors.some((e) => e.message.includes("Duplicate"))).toBe(true);
  });

  it("catches negative weights", () => {
    const errors = validateExternalProfile({
      profile_id: "neg",
      label: "Neg",
      description: "Neg",
      category_weights: { foo: -5 },
      tasks: [{ task_id: "t1", category: "foo", prompt_text: "X" }]
    });
    expect(errors.some((e) => e.field.includes("category_weights"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Building profiles
// ---------------------------------------------------------------------------

describe("buildProfileFromExternal", () => {
  it("creates a standalone custom profile", () => {
    const def: ExternalProfileDefinition = {
      profile_id: "security",
      label: "Security Focus",
      description: "Security-oriented benchmarks.",
      category_weights: { auth: 60, access_control: 40 },
      tasks: [
        { task_id: "sec_auth_001", category: "auth", prompt_text: "Does the library handle authentication?" },
        { task_id: "sec_ac_001", category: "access_control", prompt_text: "Does the library handle access control?" }
      ]
    };
    const profile = buildProfileFromExternal(def);
    expect(profile.profile_id).toBe("security");
    expect(profile.tasks).toHaveLength(2);
    expect(profile.pack.category_weights).toEqual({ auth: 60, access_control: 40 });
    expect(profile.pack.task_ids).toContain("sec_auth_001");
    expect(profile.pack.task_ids).toContain("sec_ac_001");
  });

  it("extends the default profile", () => {
    const def: ExternalProfileDefinition = {
      profile_id: "default-plus",
      label: "Default Plus Security",
      description: "Default profile with extra security tasks.",
      extends_default: true,
      category_weights: { security: 20 },
      tasks: [
        { task_id: "sec_001", category: "security", prompt_text: "Does it handle auth?" }
      ]
    };
    const profile = buildProfileFromExternal(def);
    const defaultProfile = getBenchmarkProfile("default");
    // Should have all default tasks plus the custom one
    expect(profile.tasks.length).toBe(defaultProfile.tasks.length + 1);
    expect(profile.pack.category_weights.security).toBe(20);
    // Should inherit default weights
    expect(profile.pack.category_weights.routing_accuracy).toBe(17);
  });

  it("overrides default tasks when extending", () => {
    const def: ExternalProfileDefinition = {
      profile_id: "override",
      label: "Override",
      description: "Override a default task.",
      extends_default: true,
      category_weights: {},
      tasks: [
        {
          task_id: "default_usage_001",
          category: "routing_accuracy",
          prompt_text: "CUSTOM prompt for usage"
        }
      ]
    };
    const profile = buildProfileFromExternal(def);
    const overriddenTask = profile.tasks.find((t) => t.task_id === "default_usage_001");
    expect(overriddenTask?.prompt_text).toBe("CUSTOM prompt for usage");
  });

  it("throws when task category has no weight", () => {
    const def: ExternalProfileDefinition = {
      profile_id: "orphan",
      label: "Orphan",
      description: "Orphan category.",
      category_weights: { foo: 10 },
      tasks: [
        { task_id: "t1", category: "bar", prompt_text: "X" }
      ]
    };
    expect(() => buildProfileFromExternal(def)).toThrow("category 'bar' has no weight");
  });

  it("filters weights to only active categories", () => {
    const def: ExternalProfileDefinition = {
      profile_id: "sparse",
      label: "Sparse",
      description: "Sparse.",
      category_weights: { active: 50, unused: 50 },
      tasks: [
        { task_id: "t1", category: "active", prompt_text: "X" }
      ]
    };
    const profile = buildProfileFromExternal(def);
    expect(profile.pack.category_weights).toEqual({ active: 50 });
    expect("unused" in profile.pack.category_weights).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// File loading
// ---------------------------------------------------------------------------

describe("loadProfileFromFile", () => {
  it("loads a valid profile from a JSON file", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "watchtower-profile-test-"));
    const filePath = path.join(tmpDir, "test-profile.json");
    const def: ExternalProfileDefinition = {
      profile_id: "from-file",
      label: "From File",
      description: "Loaded from disk.",
      category_weights: { testing: 100 },
      tasks: [
        { task_id: "file_test_001", category: "testing", prompt_text: "Does it work?" }
      ]
    };
    fs.writeFileSync(filePath, JSON.stringify(def), "utf8");

    const profile = loadProfileFromFile(filePath);
    expect(profile.profile_id).toBe("from-file");
    expect(profile.tasks).toHaveLength(1);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("throws on missing file", () => {
    expect(() => loadProfileFromFile("/nonexistent/profile.json")).toThrow("not found");
  });

  it("throws on invalid JSON", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "watchtower-profile-test-"));
    const filePath = path.join(tmpDir, "bad.json");
    fs.writeFileSync(filePath, "not json", "utf8");
    expect(() => loadProfileFromFile(filePath)).toThrow("Failed to parse");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("throws on invalid profile schema", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "watchtower-profile-test-"));
    const filePath = path.join(tmpDir, "invalid.json");
    fs.writeFileSync(filePath, JSON.stringify({ tasks: "not array" }), "utf8");
    expect(() => loadProfileFromFile(filePath)).toThrow("Invalid profile file");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Category subsetting
// ---------------------------------------------------------------------------

describe("subsetProfileByCategories", () => {
  it("subsets the default profile to specific categories", () => {
    const full = getBenchmarkProfile("default");
    const subset = subsetProfileByCategories(full, ["code_hygiene", "system_architecture"]);

    expect(subset.tasks.every((t) => t.category === "code_hygiene" || t.category === "system_architecture")).toBe(true);
    expect(Object.keys(subset.pack.category_weights)).toEqual(
      expect.arrayContaining(["code_hygiene", "system_architecture"])
    );
    expect(Object.keys(subset.pack.category_weights)).toHaveLength(2);
    expect(subset.profile_id).toContain("subset");
  });

  it("throws when no tasks match", () => {
    const full = getBenchmarkProfile("default");
    expect(() => subsetProfileByCategories(full, ["nonexistent_category"])).toThrow("No tasks match");
  });

  it("preserves critical regression flags", () => {
    const full = getBenchmarkProfile("default");
    const subset = subsetProfileByCategories(full, ["code_hygiene"]);
    // hygiene_bloat_001 is critical
    expect(subset.pack.critical_task_ids).toContain("hygiene_bloat_001");
  });
});

// ---------------------------------------------------------------------------
// Mock cue registry
// ---------------------------------------------------------------------------

describe("mock cue registry", () => {
  beforeEach(() => {
    // Registry is global state — tests may leak, but that's acceptable for this test scope
  });

  it("registers and looks up cues by exact task ID", () => {
    registerMockCues("custom_task_001", ["foo", "bar", "baz"]);
    expect(lookupMockCues("custom_task_001")).toEqual(["foo", "bar", "baz"]);
  });

  it("looks up cues by prefix match", () => {
    registerMockCues("custom_", ["prefix", "match"]);
    expect(lookupMockCues("custom_anything")).toEqual(["prefix", "match"]);
  });

  it("prefers exact match over prefix", () => {
    registerMockCues("exact_task", ["exact"]);
    registerMockCues("exact_", ["prefix"]);
    expect(lookupMockCues("exact_task")).toEqual(["exact"]);
  });

  it("returns undefined for unknown tasks", () => {
    expect(lookupMockCues("totally_unknown_task_xyz")).toBeUndefined();
  });

  it("registers cues from an external profile definition", () => {
    const def: ExternalProfileDefinition = {
      profile_id: "cue-test-reg",
      label: "Cue Test",
      description: "Test",
      category_weights: { test: 100 },
      tasks: [
        {
          task_id: "cuetest_reg_001",
          category: "test",
          prompt_text: "Test",
          mock_cues: ["alpha", "beta"]
        },
        {
          task_id: "cuetest_reg_002",
          category: "test",
          prompt_text: "Test without cues"
        }
      ]
    };
    registerMockCuesFromProfile(def);
    expect(lookupMockCues("cuetest_reg_001")).toEqual(["alpha", "beta"]);
    expect(lookupMockCues("cuetest_reg_002")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Task exclusion
// ---------------------------------------------------------------------------

describe("exclude_tasks and exclude_categories", () => {
  it("excludes specific tasks by ID when extending default", () => {
    const def: ExternalProfileDefinition = {
      profile_id: "pruned",
      label: "Pruned",
      description: "Default minus specific tasks.",
      extends_default: true,
      category_weights: {},
      tasks: [],
      exclude_tasks: ["default_usage_001", "default_discovery_001"]
    };
    const profile = buildProfileFromExternal(def);
    const taskIds = profile.tasks.map((t) => t.task_id);
    expect(taskIds).not.toContain("default_usage_001");
    expect(taskIds).not.toContain("default_discovery_001");
    // Other tasks should still be there
    expect(taskIds).toContain("default_boundary_001");
    expect(taskIds).toContain("default_review_001");
  });

  it("excludes entire categories when extending default", () => {
    const def: ExternalProfileDefinition = {
      profile_id: "no-constraints",
      label: "No Constraints",
      description: "Default minus constraint_handling.",
      extends_default: true,
      category_weights: {},
      tasks: [],
      exclude_categories: ["constraint_handling"]
    };
    const profile = buildProfileFromExternal(def);
    const categories = new Set(profile.tasks.map((t) => t.category));
    expect(categories.has("constraint_handling")).toBe(false);
    // Constraint weight should also be removed
    expect("constraint_handling" in profile.pack.category_weights).toBe(false);
    // Other categories preserved
    expect(categories.has("review_quality")).toBe(true);
  });

  it("combines task and category exclusion", () => {
    const def: ExternalProfileDefinition = {
      profile_id: "focused",
      label: "Focused",
      description: "Only architecture and hygiene, minus bloat task.",
      extends_default: true,
      category_weights: {},
      tasks: [],
      exclude_categories: ["routing_accuracy", "boundary_clarity", "review_quality", "handoff_quality", "constraint_handling"],
      exclude_tasks: ["hygiene_bloat_001"]
    };
    const profile = buildProfileFromExternal(def);
    const taskIds = profile.tasks.map((t) => t.task_id);
    // Should only have arch + hygiene_replace_001
    expect(taskIds).toContain("arch_structure_001");
    expect(taskIds).toContain("arch_composition_001");
    expect(taskIds).toContain("hygiene_replace_001");
    expect(taskIds).not.toContain("hygiene_bloat_001");
    expect(taskIds.length).toBe(3);
  });

  it("exclude fields are ignored when extends_default is false", () => {
    const def: ExternalProfileDefinition = {
      profile_id: "standalone-excl",
      label: "Standalone",
      description: "Standalone profile ignores exclude fields.",
      category_weights: { foo: 100 },
      tasks: [{ task_id: "t1", category: "foo", prompt_text: "X" }],
      exclude_tasks: ["default_usage_001"],
      exclude_categories: ["routing_accuracy"]
    };
    const profile = buildProfileFromExternal(def);
    expect(profile.tasks).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Configurable trial count
// ---------------------------------------------------------------------------

describe("trials_per_side configuration", () => {
  it("uses default 5 trials when not specified", () => {
    const def: ExternalProfileDefinition = {
      profile_id: "default-trials",
      label: "Default Trials",
      description: "No trial override.",
      category_weights: { test: 100 },
      tasks: [{ task_id: "t1", category: "test", prompt_text: "X" }]
    };
    const profile = buildProfileFromExternal(def);
    expect(profile.tasks[0].trials_per_side).toBe(5);
  });

  it("applies default_trials_per_side to all tasks", () => {
    const def: ExternalProfileDefinition = {
      profile_id: "fast",
      label: "Fast",
      description: "Quick run.",
      category_weights: { test: 100 },
      tasks: [
        { task_id: "t1", category: "test", prompt_text: "A" },
        { task_id: "t2", category: "test", prompt_text: "B" }
      ],
      default_trials_per_side: 3
    };
    const profile = buildProfileFromExternal(def);
    expect(profile.tasks[0].trials_per_side).toBe(3);
    expect(profile.tasks[1].trials_per_side).toBe(3);
  });

  it("per-task trials_per_side overrides profile default", () => {
    const def: ExternalProfileDefinition = {
      profile_id: "mixed-trials",
      label: "Mixed",
      description: "Mixed trial counts.",
      category_weights: { test: 100 },
      tasks: [
        { task_id: "t1", category: "test", prompt_text: "A", trials_per_side: 10 },
        { task_id: "t2", category: "test", prompt_text: "B" }
      ],
      default_trials_per_side: 2
    };
    const profile = buildProfileFromExternal(def);
    expect(profile.tasks[0].trials_per_side).toBe(10);
    expect(profile.tasks[1].trials_per_side).toBe(2);
  });

  it("clamps trials to 1-20 range", () => {
    const def: ExternalProfileDefinition = {
      profile_id: "clamped",
      label: "Clamped",
      description: "Extreme values.",
      category_weights: { test: 100 },
      tasks: [
        { task_id: "t1", category: "test", prompt_text: "A", trials_per_side: 0 },
        { task_id: "t2", category: "test", prompt_text: "B", trials_per_side: 50 }
      ]
    };
    const profile = buildProfileFromExternal(def);
    expect(profile.tasks[0].trials_per_side).toBe(1);
    expect(profile.tasks[1].trials_per_side).toBe(20);
  });

  it("applies default_trials_per_side to inherited tasks when extending", () => {
    const def: ExternalProfileDefinition = {
      profile_id: "fast-default",
      label: "Fast Default",
      description: "Extend default with fewer trials.",
      extends_default: true,
      category_weights: {},
      tasks: [],
      default_trials_per_side: 2
    };
    const profile = buildProfileFromExternal(def);
    expect(profile.tasks.every((t) => t.trials_per_side === 2)).toBe(true);
  });

  it("validates trials_per_side in profile validation", () => {
    const errors = validateExternalProfile({
      profile_id: "bad-trials",
      label: "Bad",
      description: "Bad",
      category_weights: { test: 100 },
      default_trials_per_side: 0,
      tasks: [
        { task_id: "t1", category: "test", prompt_text: "X", trials_per_side: -1 }
      ]
    });
    expect(errors.some((e) => e.field === "default_trials_per_side")).toBe(true);
    expect(errors.some((e) => e.field.includes("trials_per_side"))).toBe(true);
  });
});
