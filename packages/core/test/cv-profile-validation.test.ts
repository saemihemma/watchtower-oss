import { describe, it, expect, afterEach, vi } from "vitest";
import {
  validateExternalProfile,
  type ExternalProfileDefinition,
} from "../src/profile-loader.js";
import {
  clearExtensionScorers,
  registerExtensionScorer,
} from "../src/extension-scorer.js";

describe("CV Profile Validation", () => {
  afterEach(() => {
    clearExtensionScorers();
  });

  it("Valid CV profile", () => {
    const profile: ExternalProfileDefinition = {
      profile_id: "test-cv-profile",
      label: "Test CV Profile",
      description: "A profile with valid CV extension",
      category_weights: { reasoning: 1 },
      tasks: [
        {
          task_id: "cv-task-1",
          category: "reasoning",
          prompt_text: "Test prompt",
          extensions: {
            cv: {
              construction_cues: ["design"],
              verification_checks: [
                {
                  check_id: "check-1",
                  kind: "requires",
                  description: "Check interface",
                  rule: "requires:interface",
                  weight: 1,
                },
              ],
              construction_weight: 0.3,
              verification_weight: 0.7,
            },
          },
        },
      ],
    };

    const errors = validateExternalProfile(profile);
    expect(errors.length).toBe(0);
  });

  it("Invalid DSL rule", () => {
    const profile: ExternalProfileDefinition = {
      profile_id: "test-invalid-dsl",
      label: "Test Invalid DSL",
      description: "Profile with invalid DSL rule",
      category_weights: { reasoning: 1 },
      tasks: [
        {
          task_id: "bad-rule-task",
          category: "reasoning",
          prompt_text: "Test prompt",
          extensions: {
            cv: {
              construction_cues: [],
              verification_checks: [
                {
                  check_id: "bad-check",
                  kind: "requires",
                  description: "Bad rule",
                  rule: "requires:", // Missing ident
                  weight: 1,
                },
              ],
            },
          },
        },
      ],
    };

    const errors = validateExternalProfile(profile);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.message.includes("DSL parse error"))).toBe(
      true
    );
  });

  it("Duplicate check_id", () => {
    const profile: ExternalProfileDefinition = {
      profile_id: "test-duplicate-id",
      label: "Test Duplicate ID",
      description: "Profile with duplicate check_id",
      category_weights: { reasoning: 1 },
      tasks: [
        {
          task_id: "dup-task",
          category: "reasoning",
          prompt_text: "Test prompt",
          extensions: {
            cv: {
              construction_cues: [],
              verification_checks: [
                {
                  check_id: "same-id",
                  kind: "requires",
                  description: "First check",
                  rule: "requires:interface",
                  weight: 0.5,
                },
                {
                  check_id: "same-id",
                  kind: "requires",
                  description: "Second check",
                  rule: "requires:handler",
                  weight: 0.5,
                },
              ],
            },
          },
        },
      ],
    };

    const errors = validateExternalProfile(profile);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.message.includes("Duplicate check_id"))).toBe(
      true
    );
  });

  it("Both cv and composition on same task", () => {
    const profile: ExternalProfileDefinition = {
      profile_id: "test-both-ext",
      label: "Test Both Extensions",
      description: "Profile with both CV and composition",
      category_weights: { reasoning: 1 },
      tasks: [
        {
          task_id: "multi-ext-task",
          category: "reasoning",
          prompt_text: "Test prompt",
          extensions: {
            cv: {
              construction_cues: [],
              verification_checks: [
                {
                  check_id: "cv-check",
                  kind: "requires",
                  description: "Check",
                  rule: "requires:test",
                  weight: 1,
                },
              ],
            },
            composition: {},
          },
        },
      ],
    };

    const errors = validateExternalProfile(profile);
    expect(errors.length).toBeGreaterThan(0);
    expect(
      errors.some((e) =>
        e.message.includes("at most one extension")
      )
    ).toBe(true);
  });

  it("CV task but no scorer registered", () => {
    clearExtensionScorers();

    const warnSpy = vi.spyOn(console, "warn");

    const profile: ExternalProfileDefinition = {
      profile_id: "test-no-scorer",
      label: "Test No Scorer",
      description: "Profile with CV but no scorer",
      category_weights: { reasoning: 1 },
      tasks: [
        {
          task_id: "unscored-cv-task",
          category: "reasoning",
          prompt_text: "Test prompt",
          extensions: {
            cv: {
              construction_cues: ["pattern"],
              verification_checks: [
                {
                  check_id: "check-1",
                  kind: "requires",
                  description: "Check",
                  rule: "requires:pattern",
                  weight: 1,
                },
              ],
            },
          },
        },
      ],
    };

    const errors = validateExternalProfile(profile);

    // No validation errors should be present
    expect(errors.length).toBe(0);

    // But a warning should be logged
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls.some((c) =>
      c[0]?.toString().includes("no cv scorer registered")
    )).toBe(true);

    warnSpy.mockRestore();
  });

  it("Weight out of range", () => {
    const profile: ExternalProfileDefinition = {
      profile_id: "test-bad-weight",
      label: "Test Bad Weight",
      description: "Profile with out-of-range weight",
      category_weights: { reasoning: 1 },
      tasks: [
        {
          task_id: "bad-weight-task",
          category: "reasoning",
          prompt_text: "Test prompt",
          extensions: {
            cv: {
              construction_cues: [],
              verification_checks: [
                {
                  check_id: "check-1",
                  kind: "requires",
                  description: "Check",
                  rule: "requires:test",
                  weight: 1.5, // Out of range
                },
              ],
              construction_weight: 0.3,
              verification_weight: 0.7,
            },
          },
        },
      ],
    };

    const errors = validateExternalProfile(profile);
    expect(errors.length).toBeGreaterThan(0);
    expect(
      errors.some((e) =>
        e.message.includes("must be a number between 0 and 1")
      )
    ).toBe(true);
  });

  it("Weights don't sum to 1.0", () => {
    const profile: ExternalProfileDefinition = {
      profile_id: "test-bad-sum",
      label: "Test Bad Sum",
      description: "Profile with weights that don't sum to 1.0",
      category_weights: { reasoning: 1 },
      tasks: [
        {
          task_id: "bad-sum-task",
          category: "reasoning",
          prompt_text: "Test prompt",
          extensions: {
            cv: {
              construction_cues: [],
              verification_checks: [
                {
                  check_id: "check-1",
                  kind: "requires",
                  description: "Check",
                  rule: "requires:test",
                  weight: 1,
                },
              ],
              construction_weight: 0.6,
              verification_weight: 0.7, // Sum = 1.3
            },
          },
        },
      ],
    };

    const errors = validateExternalProfile(profile);
    expect(errors.length).toBeGreaterThan(0);
    expect(
      errors.some((e) =>
        e.message.includes("expected 1.0")
      )
    ).toBe(true);
  });

  it("Default weights (omitted)", () => {
    const profile: ExternalProfileDefinition = {
      profile_id: "test-default-weights",
      label: "Test Default Weights",
      description: "Profile with default weights",
      category_weights: { reasoning: 1 },
      tasks: [
        {
          task_id: "default-weight-task",
          category: "reasoning",
          prompt_text: "Test prompt",
          extensions: {
            cv: {
              construction_cues: [],
              verification_checks: [
                {
                  check_id: "check-1",
                  kind: "requires",
                  description: "Check",
                  rule: "requires:test",
                  weight: 1,
                },
              ],
              // No construction_weight or verification_weight
            },
          },
        },
      ],
    };

    const errors = validateExternalProfile(profile);
    expect(
      errors.filter((e) => e.message.includes("weight")).length
    ).toBe(0);
  });
});
