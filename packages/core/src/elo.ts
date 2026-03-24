/**
 * Simple Elo ranking system for Watchtower.
 * Stores everything in a single JSON file - no SQL, no server.
 *
 * K-factor defaults to 32 (standard for systems with moderate volatility).
 * Starting Elo is 1500.
 */

import fs from "node:fs";
import path from "node:path";
import { ELO_INITIAL_RATING, ELO_K_FACTOR } from "./constants.js";
import type { ComparisonRun, EloEntry, EloLedger, EloMatchRecord } from "./schemas.js";

export function createEmptyLedger(kFactor = ELO_K_FACTOR): EloLedger {
  return {
    schema_version: 1,
    k_factor: kFactor,
    entries: [],
    history: []
  };
}

export function loadEloLedger(dataRoot: string): EloLedger {
  const filePath = path.join(dataRoot, "elo.json");
  if (!fs.existsSync(filePath)) {
    return createEmptyLedger();
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as EloLedger;
  } catch {
    return createEmptyLedger();
  }
}

export function saveEloLedger(dataRoot: string, ledger: EloLedger): void {
  const filePath = path.join(dataRoot, "elo.json");
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(ledger, null, 2), "utf8");
}

/**
 * Derive a stable library ID from a root path.
 * Uses the last two path segments to create a human-readable ID.
 */
function deriveLibraryId(rootPath: string): string {
  const normalized = rootPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const segments = normalized.split("/");
  const tail = segments.slice(-2).join("/");
  return tail.toLowerCase().replace(/[^a-z0-9/\-_.]/g, "_");
}

function findOrCreateEntry(ledger: EloLedger, rootPath: string, label: string): EloEntry {
  const id = deriveLibraryId(rootPath);
  let entry = ledger.entries.find((candidate) => candidate.library_id === id);
  if (!entry) {
    entry = {
      library_id: id,
      label,
      root_path: rootPath,
      elo: ELO_INITIAL_RATING,
      wins: 0,
      losses: 0,
      draws: 0,
      last_run_id: "",
      last_updated: new Date().toISOString()
    };
    ledger.entries.push(entry);
  }
  entry.label = label;
  return entry;
}

/**
 * Standard Elo expected score: E_A = 1 / (1 + 10^((R_B - R_A) / 400))
 */
function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

/**
 * Compute Elo delta for one side.
 * actual = 1 for win, 0.5 for draw, 0 for loss.
 */
function eloDelta(kFactor: number, expected: number, actual: number): number {
  return Math.round(kFactor * (actual - expected));
}

/**
 * Record the result of a comparison run in the Elo ledger.
 * Returns the updated ledger (mutated in place) and the match record.
 */
export function recordEloMatch(
  ledger: EloLedger,
  run: ComparisonRun
): { ledger: EloLedger; match: EloMatchRecord } {
  const leftEntry = findOrCreateEntry(ledger, run.left_side.root_path, run.left_side.label);
  const rightEntry = findOrCreateEntry(ledger, run.right_side.root_path, run.right_side.label);

  const leftEloBefore = leftEntry.elo;
  const rightEloBefore = rightEntry.elo;

  const expectedLeft = expectedScore(leftEntry.elo, rightEntry.elo);
  const expectedRight = 1 - expectedLeft;

  let actualLeft: number;
  let actualRight: number;

  if (run.winner === "left") {
    actualLeft = 1;
    actualRight = 0;
    leftEntry.wins += 1;
    rightEntry.losses += 1;
  } else if (run.winner === "right") {
    actualLeft = 0;
    actualRight = 1;
    rightEntry.wins += 1;
    leftEntry.losses += 1;
  } else {
    actualLeft = 0.5;
    actualRight = 0.5;
    leftEntry.draws += 1;
    rightEntry.draws += 1;
  }

  leftEntry.elo += eloDelta(ledger.k_factor, expectedLeft, actualLeft);
  rightEntry.elo += eloDelta(ledger.k_factor, expectedRight, actualRight);
  leftEntry.last_run_id = run.run_id;
  rightEntry.last_run_id = run.run_id;

  const now = new Date().toISOString();
  leftEntry.last_updated = now;
  rightEntry.last_updated = now;

  const match: EloMatchRecord = {
    run_id: run.run_id,
    left_id: leftEntry.library_id,
    right_id: rightEntry.library_id,
    winner: run.winner,
    left_elo_before: leftEloBefore,
    right_elo_before: rightEloBefore,
    left_elo_after: leftEntry.elo,
    right_elo_after: rightEntry.elo,
    timestamp: now
  };

  ledger.history.push(match);
  return { ledger, match };
}

/**
 * Get the leaderboard sorted by Elo descending.
 */
export function getLeaderboard(ledger: EloLedger): EloEntry[] {
  return [...ledger.entries].sort((left, right) => right.elo - left.elo);
}

/**
 * Get match history for a specific library.
 */
export function getLibraryHistory(ledger: EloLedger, libraryId: string): EloMatchRecord[] {
  return ledger.history.filter((match) => match.left_id === libraryId || match.right_id === libraryId);
}

/**
 * Render leaderboard as readable text.
 */
export function renderLeaderboard(ledger: EloLedger): string {
  const board = getLeaderboard(ledger);
  if (board.length === 0) {
    return "No Elo rankings yet. Run a comparison to start tracking.";
  }

  const lines = [
    "# Watchtower Elo Leaderboard",
    "",
    "| Rank | Library | Elo | W | L | D | Last Updated |",
    "|------|---------|-----|---|---|---|--------------|"
  ];

  for (let index = 0; index < board.length; index += 1) {
    const entry = board[index];
    const date = entry.last_updated.split("T")[0];
    lines.push(
      `| ${index + 1} | ${entry.label} | ${entry.elo} | ${entry.wins} | ${entry.losses} | ${entry.draws} | ${date} |`
    );
  }

  return lines.join("\n");
}

/**
 * Render match history as readable text.
 */
export function renderMatchHistory(ledger: EloLedger, limit = 20): string {
  const recent = ledger.history.slice(-limit).reverse();
  if (recent.length === 0) {
    return "No match history yet.";
  }

  const lines = [
    "# Watchtower Match History",
    "",
    "| Run | Left | Right | Winner | Left Elo | Right Elo | Date |",
    "|-----|------|-------|--------|----------|-----------|------|"
  ];

  for (const match of recent) {
    const winLabel = match.winner === "too_close_to_call" ? "draw" : match.winner;
    const date = match.timestamp.split("T")[0];
    lines.push(
      `| ${match.run_id.slice(0, 8)}... | ${match.left_id} (${match.left_elo_before}->${match.left_elo_after}) | ${match.right_id} (${match.right_elo_before}->${match.right_elo_after}) | ${winLabel} | ${match.left_elo_after} | ${match.right_elo_after} | ${date} |`
    );
  }

  return lines.join("\n");
}
