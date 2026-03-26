import { describe, it, expect } from "vitest";
import {
  createEmptyLedger,
  recordEloMatch,
  getLeaderboard,
  getLibraryHistory,
  renderLeaderboard,
  renderMatchHistory
} from "../src/elo.js";
import type { ComparisonRun, EloLedger } from "../src/schemas.js";

function fakeRun(overrides: Partial<ComparisonRun> = {}): ComparisonRun {
  return {
    run_id: "test-run-001",
    schema_version: 2,
    profile_id: "default",
    comparison_mode: "cross_library",
    benchmark_pack: {
      pack_id: "test-pack",
      source: "built_in_pack",
      task_ids: [],
      category_weights: { routing_accuracy: 30, boundary_clarity: 25, review_quality: 25, handoff_quality: 20 },
      critical_task_ids: [],
      catalog_hash: "abc"
    },
    winner: "left",
    left_side: {
      side_id: "left",
      label: "Alpha Skills",
      root_path: "/workspace/alpha-skills",
      snapshot_id: "snap1",
      snapshot_dir: "/tmp/snap1"
    },
    right_side: {
      side_id: "right",
      label: "Beta Skills",
      root_path: "/workspace/beta-skills",
      snapshot_id: "snap2",
      snapshot_dir: "/tmp/snap2"
    },
    selected_task_ids: [],
    selected_task_versions: [],
    evaluator_versions: { executor: "mock-v3" },
    task_trial_results: [],
    task_side_summaries: [],
    scorecard: {
      left_score: 75,
      right_score: 50,
      delta: -25,
      confidence: "high",
      category_scores: [],
      top_reasons: ["Left led everywhere"],
      regressions: []
    },
    devils_advocate: { verdict: "clear", arguments: [] },
    recommended_action: "keep_separate",
    replace_eligible: false,
    action_offers: ["keep_separate"],
    artifact_refs: [],
    run_path: null,
    report_path: null,
    created_at: new Date().toISOString(),
    ...overrides
  };
}

describe("Elo system", () => {
  it("creates empty ledger with defaults", () => {
    const ledger = createEmptyLedger();
    expect(ledger.schema_version).toBe(1);
    expect(ledger.k_factor).toBe(32);
    expect(ledger.entries).toHaveLength(0);
    expect(ledger.history).toHaveLength(0);
  });

  it("records a left win correctly", () => {
    const ledger = createEmptyLedger();
    const run = fakeRun({ winner: "left" });
    const { match } = recordEloMatch(ledger, run);

    expect(ledger.entries).toHaveLength(2);
    expect(match.winner).toBe("left");

    const left = ledger.entries.find((e) => e.label === "Alpha Skills")!;
    const right = ledger.entries.find((e) => e.label === "Beta Skills")!;

    // Both start at 1500. Left wins → left goes up, right goes down
    expect(left.elo).toBeGreaterThan(1500);
    expect(right.elo).toBeLessThan(1500);
    expect(left.wins).toBe(1);
    expect(left.losses).toBe(0);
    expect(right.wins).toBe(0);
    expect(right.losses).toBe(1);

    // Elo is zero-sum: delta_left + delta_right = 0
    expect(left.elo + right.elo).toBe(3000);
  });

  it("records a right win correctly", () => {
    const ledger = createEmptyLedger();
    const run = fakeRun({ winner: "right" });
    const { match } = recordEloMatch(ledger, run);

    const left = ledger.entries.find((e) => e.label === "Alpha Skills")!;
    const right = ledger.entries.find((e) => e.label === "Beta Skills")!;

    expect(right.elo).toBeGreaterThan(1500);
    expect(left.elo).toBeLessThan(1500);
    expect(match.winner).toBe("right");
  });

  it("records a draw correctly", () => {
    const ledger = createEmptyLedger();
    const run = fakeRun({ winner: "too_close_to_call" });
    recordEloMatch(ledger, run);

    const left = ledger.entries.find((e) => e.label === "Alpha Skills")!;
    const right = ledger.entries.find((e) => e.label === "Beta Skills")!;

    // Both at 1500, draw → no change
    expect(left.elo).toBe(1500);
    expect(right.elo).toBe(1500);
    expect(left.draws).toBe(1);
    expect(right.draws).toBe(1);
  });

  it("updates existing entries across multiple matches", () => {
    const ledger = createEmptyLedger();

    // First match: left wins
    recordEloMatch(ledger, fakeRun({ run_id: "run-1", winner: "left" }));
    // Second match: left wins again
    recordEloMatch(ledger, fakeRun({ run_id: "run-2", winner: "left" }));

    expect(ledger.entries).toHaveLength(2);
    expect(ledger.history).toHaveLength(2);

    const left = ledger.entries.find((e) => e.label === "Alpha Skills")!;
    const right = ledger.entries.find((e) => e.label === "Beta Skills")!;

    expect(left.wins).toBe(2);
    expect(right.losses).toBe(2);
    // After 2 wins, left should be further from 1500
    expect(left.elo).toBeGreaterThan(1516); // first win gives +16
    expect(left.last_run_id).toBe("run-2");
  });

  it("higher-rated player gains less from beating lower-rated", () => {
    const ledger = createEmptyLedger();

    // Give left a big lead first (3 wins)
    recordEloMatch(ledger, fakeRun({ run_id: "r1", winner: "left" }));
    recordEloMatch(ledger, fakeRun({ run_id: "r2", winner: "left" }));
    recordEloMatch(ledger, fakeRun({ run_id: "r3", winner: "left" }));

    const leftBefore = ledger.entries.find((e) => e.label === "Alpha Skills")!.elo;
    recordEloMatch(ledger, fakeRun({ run_id: "r4", winner: "left" }));
    const leftAfter = ledger.entries.find((e) => e.label === "Alpha Skills")!.elo;

    const gain = leftAfter - leftBefore;
    // Expected gain should be less than 16 (the K/2 for equal ratings)
    expect(gain).toBeLessThan(16);
    expect(gain).toBeGreaterThan(0);
  });

  it("leaderboard sorts by Elo descending", () => {
    const ledger = createEmptyLedger();
    recordEloMatch(ledger, fakeRun({ winner: "left" }));

    const board = getLeaderboard(ledger);
    expect(board[0].label).toBe("Alpha Skills");
    expect(board[1].label).toBe("Beta Skills");
    expect(board[0].elo).toBeGreaterThan(board[1].elo);
  });

  it("library history filters correctly", () => {
    const ledger = createEmptyLedger();
    recordEloMatch(ledger, fakeRun({ run_id: "r1", winner: "left" }));

    const leftId = ledger.entries.find((e) => e.label === "Alpha Skills")!.library_id;
    const history = getLibraryHistory(ledger, leftId);
    expect(history).toHaveLength(1);
    expect(history[0].run_id).toBe("r1");
  });

  it("renders leaderboard text", () => {
    const ledger = createEmptyLedger();
    recordEloMatch(ledger, fakeRun({ winner: "left" }));

    const text = renderLeaderboard(ledger);
    expect(text).toContain("Elo Leaderboard");
    expect(text).toContain("Alpha Skills");
    expect(text).toContain("Beta Skills");
  });

  it("renders empty leaderboard", () => {
    const ledger = createEmptyLedger();
    const text = renderLeaderboard(ledger);
    expect(text).toContain("No Elo rankings yet");
  });

  it("renders match history", () => {
    const ledger = createEmptyLedger();
    recordEloMatch(ledger, fakeRun({ run_id: "run-abc-123", winner: "left" }));

    const text = renderMatchHistory(ledger);
    expect(text).toContain("Match History");
    expect(text).toContain("run-abc");
  });
});
