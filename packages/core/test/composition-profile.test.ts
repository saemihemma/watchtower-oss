import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { validateExternalProfile } from "../src/profile-loader.js";
import { registerExtensionScorer, clearExtensionScorers } from "../src/extension-scorer.js";
import type { ExtensionScorer } from "../src/extension-scorer.js";

describe("composition profile validation", () => {
  const mockCompositionScorer: ExtensionScorer = {
    kind: "composition",
    applicable: () => true,
    score: async () => ({ normalizedScore: 0, metadata: {}, warnings: [] }),
  };

  beforeEach(() => {
    clearExtensionScorers();
    registerExtensionScorer(mockCompositionScorer);
  });

  afterEach(() => {
    clearExtensionScorers();
  });

  function makeValidCompositionProfile() {
    return {
      profile_id: "comp-test",
      label: "Composition Test",
      description: "Tests composition validation",
      category_weights: { test_cat: 1 },
      tasks: [
        {
          task_id: "p1",
          category: "test_cat",
          prompt_text: "Primitive task 1",
          extensions: {
            composition: { layer: "primitive" },
          },
        },
        {
          task_id: "p2",
          category: "test_cat",
          prompt_text: "Primitive task 2",
          extensions: {
            composition: { layer: "primitive" },
          },
        },
        {
          task_id: "c1",
          category: "test_cat",
          prompt_text: "Composed task 1",
          extensions: {
            composition: {
              layer: "composed",
              dependencies: ["p1", "p2"],
              composition_cues: ["alpha", "beta"],
            },
          },
        },
        {
          task_id: "m1",
          category: "test_cat",
          prompt_text: "Meta task 1",
          extensions: {
            composition: {
              layer: "meta",
              dependencies: ["c1"],
            },
          },
        },
      ],
    };
  }

  // Test 1: Valid composition profile
  it("accepts valid composition profile", () => {
    const errors = validateExternalProfile(makeValidCompositionProfile());
    expect(errors).toHaveLength(0);
  });

  // Test 2: Cyclic dependency
  it("rejects cyclic dependencies", () => {
    const profile = makeValidCompositionProfile();
    // Make c1 depend on m1, and m1 depend on c1 (cycle)
    profile.tasks = [
      {
        task_id: "c1",
        category: "test_cat",
        prompt_text: "Composed 1",
        extensions: { composition: { layer: "composed", dependencies: ["c2"] } },
      },
      {
        task_id: "c2",
        category: "test_cat",
        prompt_text: "Composed 2",
        extensions: { composition: { layer: "composed", dependencies: ["c1"] } },
      },
    ];
    const errors = validateExternalProfile(profile);
    expect(errors.some(e => e.field === "composition_dag")).toBe(true);
  });

  // Test 3: Missing dependency target
  it("rejects missing dependency target", () => {
    const profile = makeValidCompositionProfile();
    profile.tasks = [
      {
        task_id: "c1",
        category: "test_cat",
        prompt_text: "Composed 1",
        extensions: { composition: { layer: "composed", dependencies: ["nonexistent"] } },
      },
    ];
    const errors = validateExternalProfile(profile);
    expect(errors.some(e => e.message.includes("unknown task 'nonexistent'"))).toBe(true);
  });

  // Test 4: Invalid layer value
  it("rejects invalid layer value", () => {
    const profile = {
      profile_id: "comp-test",
      label: "Test",
      description: "Test",
      category_weights: { test_cat: 1 },
      tasks: [
        {
          task_id: "t1",
          category: "test_cat",
          prompt_text: "Test",
          extensions: { composition: { layer: "invalid" } },
        },
      ],
    };
    const errors = validateExternalProfile(profile);
    expect(errors.some(e => e.field.includes("layer"))).toBe(true);
  });

  // Test 5: collapse_config accepted
  it("accepts valid collapse_config", () => {
    const profile = makeValidCompositionProfile() as Record<string, unknown>;
    profile.collapse_config = { primitive_floor: 0.7, composed_ceiling: 0.2 };
    const errors = validateExternalProfile(profile);
    expect(errors).toHaveLength(0);
  });

  // Test 6: collapse_config out of range
  it("rejects collapse_config out of range", () => {
    const profile = makeValidCompositionProfile() as Record<string, unknown>;
    profile.collapse_config = { primitive_floor: -0.1, composed_ceiling: 1.5 };
    const errors = validateExternalProfile(profile);
    expect(errors.some(e => e.field === "collapse_config.primitive_floor")).toBe(true);
    expect(errors.some(e => e.field === "collapse_config.composed_ceiling")).toBe(true);
  });

  // Test 7: collapse_config floor ≤ ceiling
  it("rejects collapse_config where floor ≤ ceiling", () => {
    const profile = makeValidCompositionProfile() as Record<string, unknown>;
    profile.collapse_config = { primitive_floor: 0.3, composed_ceiling: 0.5 };
    const errors = validateExternalProfile(profile);
    expect(errors.some(e => e.field === "collapse_config" && e.message.includes("must be greater than"))).toBe(true);
  });
});
