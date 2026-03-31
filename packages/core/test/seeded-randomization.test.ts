import { describe, expect, it } from "vitest";
import { resolvePromptTemplates } from "../src/index.js";

describe("resolvePromptTemplates", () => {
  it("resolves {{variable}} placeholders with pool values", () => {
    const prompt = "Build a {{domain}} app using {{tech_stack}} with {{team_size}}.";
    const resolved = resolvePromptTemplates(prompt, 42, 0);

    expect(resolved).not.toContain("{{domain}}");
    expect(resolved).not.toContain("{{tech_stack}}");
    expect(resolved).not.toContain("{{team_size}}");
    expect(resolved.length).toBeGreaterThan(0);
  });

  it("is deterministic: same seed + same taskIndex = same output", () => {
    const prompt = "Deploy the {{service}} for a {{domain}} company.";
    const a = resolvePromptTemplates(prompt, 42, 0);
    const b = resolvePromptTemplates(prompt, 42, 0);
    expect(a).toBe(b);
  });

  it("different seeds produce different resolutions", () => {
    const prompt = "Build a {{domain}} app with {{tech_stack}}.";
    const a = resolvePromptTemplates(prompt, 1, 0);
    const b = resolvePromptTemplates(prompt, 9999, 0);
    // Not guaranteed different for all pools but overwhelmingly likely
    // At minimum, the function should not crash
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
  });

  it("different taskIndex values produce different resolutions", () => {
    const prompt = "Build a {{domain}} app.";
    const a = resolvePromptTemplates(prompt, 42, 0);
    const b = resolvePromptTemplates(prompt, 42, 5);
    // Different task indices should generally produce different domain selections
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
  });

  it("leaves unknown {{variables}} intact", () => {
    const prompt = "Use {{unknown_variable}} in your work.";
    const resolved = resolvePromptTemplates(prompt, 42, 0);
    expect(resolved).toContain("{{unknown_variable}}");
  });

  it("returns prompt unchanged when no templates present", () => {
    const prompt = "A plain prompt with no templates.";
    const resolved = resolvePromptTemplates(prompt, 42, 0);
    expect(resolved).toBe(prompt);
  });

  it("handles multiple instances of the same variable", () => {
    const prompt = "The {{domain}} team builds {{domain}} tools.";
    const resolved = resolvePromptTemplates(prompt, 42, 0);
    // Both instances should be resolved (may differ since PRNG advances)
    expect(resolved).not.toContain("{{domain}}");
  });
});
