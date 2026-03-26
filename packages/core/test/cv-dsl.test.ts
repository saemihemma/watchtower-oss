import { describe, it, expect } from "vitest";
import { parseRule, evaluateRule, DSLParseError, type RuleNode } from "../src/cv-dsl.js";

describe("DSL Parser", () => {
  it("parses requires:interface", () => {
    const result = parseRule("requires:interface");
    expect(result).toEqual({
      type: "requires",
      ident: "interface",
    });
  });

  it("parses requires:X AND absent:Y", () => {
    const result = parseRule("requires:X AND absent:Y");
    expect(result).toEqual({
      type: "and",
      children: [
        { type: "requires", ident: "X" },
        { type: "absent", ident: "Y" },
      ],
    });
  });

  it("parses requires:X OR requires:Y", () => {
    const result = parseRule("requires:X OR requires:Y");
    expect(result).toEqual({
      type: "or",
      children: [
        { type: "requires", ident: "X" },
        { type: "requires", ident: "Y" },
      ],
    });
  });

  it("parses NOT requires:X", () => {
    const result = parseRule("NOT requires:X");
    expect(result).toEqual({
      type: "not",
      child: { type: "requires", ident: "X" },
    });
  });

  it("parses (requires:X OR requires:Y) AND absent:Z with correct nesting", () => {
    const result = parseRule("(requires:X OR requires:Y) AND absent:Z");
    expect(result).toEqual({
      type: "and",
      children: [
        {
          type: "or",
          children: [
            { type: "requires", ident: "X" },
            { type: "requires", ident: "Y" },
          ],
        },
        { type: "absent", ident: "Z" },
      ],
    });
  });

  it("parses before:planning,implementation", () => {
    const result = parseRule("before:planning,implementation");
    expect(result).toEqual({
      type: "before",
      first: "planning",
      second: "implementation",
    });
  });

  it("parses count:fallback>=2", () => {
    const result = parseRule("count:fallback>=2");
    expect(result).toEqual({
      type: "count",
      ident: "fallback",
      min: 2,
    });
  });

  it("parses section:\"Error Handling\"", () => {
    const result = parseRule('section:"Error Handling"');
    expect(result).toEqual({
      type: "section",
      title: "Error Handling",
    });
  });

  it("throws DSLParseError for requires: with no ident", () => {
    expect(() => parseRule("requires:")).toThrow(DSLParseError);
    try {
      parseRule("requires:");
    } catch (e) {
      if (e instanceof DSLParseError) {
        expect(e.position).toBeDefined();
      } else {
        throw e;
      }
    }
  });

  it("throws DSLParseError for unmatched opening paren", () => {
    expect(() => parseRule("(requires:X")).toThrow(DSLParseError);
    try {
      parseRule("(requires:X");
    } catch (e) {
      if (e instanceof DSLParseError) {
        expect(e.position).toBeDefined();
      } else {
        throw e;
      }
    }
  });
});

describe("DSL Evaluator", () => {
  it("evaluates requires:interface with matching text", () => {
    const rule = parseRule("requires:interface");
    const result = evaluateRule(rule, "The interface layer is well-designed");
    expect(result).toBe(true);
  });

  it("evaluates requires:interface as false with non-matching text", () => {
    const rule = parseRule("requires:interface");
    const result = evaluateRule(rule, "No such keyword here");
    expect(result).toBe(false);
  });

  it("evaluates before:plan,execute with correct order", () => {
    const rule = parseRule("before:plan,execute");
    const result = evaluateRule(rule, "First plan, then execute the steps");
    expect(result).toBe(true);
  });

  it("evaluates before:plan,execute as false with incorrect order", () => {
    const rule = parseRule("before:plan,execute");
    const result = evaluateRule(rule, "Execute then plan the next phase");
    expect(result).toBe(false);
  });

  it("evaluates absent:hack with text that doesn't contain it", () => {
    const rule = parseRule("absent:hack");
    const result = evaluateRule(rule, "Clean code here");
    expect(result).toBe(true);
  });

  it("evaluates count:error>=2 with sufficient occurrences", () => {
    const rule = parseRule("count:error>=2");
    const result = evaluateRule(
      rule,
      "error one, error two, error three"
    );
    expect(result).toBe(true);
  });

  it("evaluates section:\"Error Handling\" with matching markdown heading", () => {
    const rule = parseRule('section:"Error Handling"');
    const result = evaluateRule(
      rule,
      "## Error Handling\nStuff here"
    );
    expect(result).toBe(true);
  });

  it("evaluates (requires:X OR requires:Y) AND absent:Z with matching conditions", () => {
    const rule = parseRule("(requires:X OR requires:Y) AND absent:Z");
    const result = evaluateRule(rule, "has X but not that letter");
    expect(result).toBe(true);
  });

  it("evaluates after:execute,plan with correct order", () => {
    const rule = parseRule("after:execute,plan");
    const result = evaluateRule(rule, "First plan, then execute");
    expect(result).toBe(true);
  });

  it("evaluates before:plan,execute as false when execute is missing", () => {
    const rule = parseRule("before:plan,execute");
    const result = evaluateRule(rule, "only plan mentioned");
    expect(result).toBe(false);
  });
});
