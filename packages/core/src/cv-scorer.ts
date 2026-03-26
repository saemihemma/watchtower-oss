/**
 * Construction-Verification (C-V) extension scorer.
 *
 * Implements ExtensionScorer for tasks with extensions.cv.
 * Mock executor: evaluates construction cues by substring matching,
 * verification checks by DSL evaluation against concatenated bundle text.
 *
 * Firewall: if any critical check fails and firewall=true,
 * verification contribution is zeroed in the combined score.
 */

import fs from "node:fs";
import path from "node:path";
import type {
  ExtensionScorer,
  ExtensionScoredResult,
} from "./extension-scorer.js";
import type {
  BenchmarkTask,
  ExecutorInput,
  ExecutorOutput,
  CVTaskExtension,
  CVCheck,
  CVResult,
} from "./schemas.js";
import { parseRule, evaluateRule } from "./cv-dsl.js";
import {
  CV_CONSTRUCTION_WEIGHT_DEFAULT,
  CV_VERIFICATION_WEIGHT_DEFAULT,
} from "./constants.js";

// ---------------------------------------------------------------------------
// Bundle text cache (per bundleDir)
// ---------------------------------------------------------------------------

const bundleTextCache = new Map<string, string>();

/**
 * Read and concatenate all .md files from a bundle directory.
 * Caches per bundleDir to avoid redundant I/O when scoring multiple tasks.
 */
export function getBundleText(bundleDir: string): string {
  const cached = bundleTextCache.get(bundleDir);
  if (cached !== undefined) return cached;

  let text = "";
  try {
    const entries = fs.readdirSync(bundleDir);
    const mdFiles = entries.filter(e => e.endsWith(".md")).sort();
    const parts: string[] = [];
    for (const file of mdFiles) {
      const content = fs.readFileSync(path.join(bundleDir, file), "utf-8");
      parts.push(content);
    }
    text = parts.join("\n---\n");
  } catch {
    // bundleDir doesn't exist or unreadable → empty text
    text = "";
  }

  bundleTextCache.set(bundleDir, text);
  return text;
}

/**
 * Clear bundle text cache. For test isolation.
 */
export function clearBundleTextCache(): void {
  bundleTextCache.clear();
}

// ---------------------------------------------------------------------------
// Construction scoring
// ---------------------------------------------------------------------------

function scoreConstruction(
  ext: CVTaskExtension,
  bundleText: string,
  baseScore: number
): { score: number; details: string[] } {
  if (ext.construction_cues.length === 0) {
    return { score: baseScore, details: ["No construction cues defined; using base executor score."] };
  }

  const details: string[] = [];
  let found = 0;
  const lower = bundleText.toLowerCase();

  for (const cue of ext.construction_cues) {
    if (lower.includes(cue.toLowerCase())) {
      found++;
      details.push(`✓ cue '${cue}' found`);
    } else {
      details.push(`✗ cue '${cue}' missing`);
    }
  }

  return {
    score: found / ext.construction_cues.length,
    details,
  };
}

// ---------------------------------------------------------------------------
// Verification scoring
// ---------------------------------------------------------------------------

function scoreVerification(
  ext: CVTaskExtension,
  bundleText: string,
  baseScore: number
): {
  score: number;
  details: string[];
  criticalFailure: boolean;
  warnings: string[];
  passed: number;
  failed: number;
} {
  if (ext.verification_checks.length === 0) {
    return {
      score: baseScore,
      details: ["No verification checks defined; using base executor score."],
      criticalFailure: false,
      warnings: [],
      passed: 0,
      failed: 0,
    };
  }

  const details: string[] = [];
  const warnings: string[] = [];
  let criticalFailure = false;
  let passed = 0;
  let failed = 0;
  let weightedSum = 0;
  let totalWeight = 0;

  for (const check of ext.verification_checks) {
    let result: boolean;
    try {
      const ast = parseRule(check.rule);
      result = evaluateRule(ast, bundleText);
    } catch (err) {
      // Rule should have been validated at profile load — but be safe
      result = false;
      warnings.push(
        `Check '${check.check_id}' rule parse error: ${err instanceof Error ? err.message : "unknown"}`
      );
    }

    if (result) {
      passed++;
      details.push(`✓ [${check.check_id}] ${check.description}`);
    } else {
      failed++;
      details.push(`✗ [${check.check_id}] ${check.description}`);
      if (check.critical) {
        criticalFailure = true;
      }
    }

    weightedSum += check.weight * (result ? 1 : 0);
    totalWeight += check.weight;
  }

  // Weighted average; degenerate case: all weights 0 → score 0
  const score = totalWeight > 0 ? weightedSum / totalWeight : 0;

  return { score, details, criticalFailure, warnings, passed, failed };
}

// ---------------------------------------------------------------------------
// CV Scorer factory
// ---------------------------------------------------------------------------

export function createCVScorer(): ExtensionScorer {
  return {
    kind: "cv",

    applicable(task: BenchmarkTask): boolean {
      return task.extensions?.cv !== undefined;
    },

    async score(
      input: ExecutorInput,
      baseResult: ExecutorOutput
    ): Promise<ExtensionScoredResult> {
      const ext = input.task.extensions!.cv!;
      const bundleText = getBundleText(input.bundleDir);
      const baseScore = baseResult.normalizedScore ?? 0;

      // 1. Construction phase
      const construction = scoreConstruction(ext, bundleText, baseScore);

      // 2. Verification phase
      const verification = scoreVerification(ext, bundleText, baseScore);

      // 3. Weights
      const cw = ext.construction_weight ?? CV_CONSTRUCTION_WEIGHT_DEFAULT;
      const vw = ext.verification_weight ?? CV_VERIFICATION_WEIGHT_DEFAULT;

      // 4. Firewall: critical failure zeroes verification contribution
      const firewalled = ext.firewall !== false && verification.criticalFailure;
      const combinedScore = firewalled
        ? cw * construction.score
        : cw * construction.score + vw * verification.score;

      // 5. Shortcut detection (preliminary thresholds)
      const shortcutDetected =
        construction.score > 0.8 && verification.score < 0.3;

      const cvResult: CVResult = {
        construction_score: construction.score,
        verification_score: verification.score,
        combined_score: combinedScore,
        construction_details: construction.details,
        verification_details: verification.details,
        checks_passed: verification.passed,
        checks_failed: verification.failed,
        checks_total: ext.verification_checks.length,
        shortcut_detected: shortcutDetected,
        critical_failure: verification.criticalFailure,
      };

      return {
        normalizedScore: combinedScore,
        metadata: { scorer_kind: "cv", cv_result: cvResult },
        warnings: verification.warnings,
      };
    },
  };
}
