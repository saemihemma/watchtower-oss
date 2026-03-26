/**
 * Profile loader for external benchmark profiles.
 *
 * Supports loading custom profiles from JSON files on disk, validating them,
 * and merging them with built-in defaults. This is the extensibility layer
 * that lets users define their own benchmark tasks, categories, and weights
 * without modifying Watchtower source code.
 */

import fs from "node:fs";
import path from "node:path";
import { computeBenchmarkPackHash } from "./hashing.js";
import type {
  BenchmarkCategory,
  BenchmarkProfile,
  BenchmarkTask,
  CollapseConfig,
  CompositionLayer,
  CompositionTaskExtension,
  CVCheck,
  CVTaskExtension,
  EvaluatorKind,
  TaskExtensions,
} from "./schemas.js";
import { getBenchmarkProfile, BUILTIN_CATEGORY_WEIGHTS } from "./builtin-benchmark.js";
import { validateCompositionDAG, type DAGNode } from "./composition-dag.js";
import { parseRule, DSLParseError } from "./cv-dsl.js";
import { getRegisteredScorers } from "./extension-scorer.js";
import { CV_CONSTRUCTION_WEIGHT_DEFAULT, CV_VERIFICATION_WEIGHT_DEFAULT } from "./constants.js";

// ---------------------------------------------------------------------------
// External profile schema (what users write in JSON files)
// ---------------------------------------------------------------------------

export type ExternalTaskDefinition = {
  task_id: string;
  category: string;
  prompt_text: string;
  rubric_text?: string | null;
  critical_regression?: boolean;
  evaluator_kind?: EvaluatorKind;
  priority?: number;
  min_valid_trials?: number;
  /** Number of trials per side. Default: 5. Range: 1–20. */
  trials_per_side?: number;
  /** Optional cue keywords for the mock executor. */
  mock_cues?: string[];
  /** Optional C-V or Composition extension. At most one. */
  extensions?: {
    cv?: {
      construction_cues: string[];
      verification_checks: Array<{
        check_id: string;
        kind: string;
        description: string;
        rule: string;
        weight: number;
        critical?: boolean;
      }>;
      construction_weight?: number;
      verification_weight?: number;
      firewall?: boolean;
    };
    composition?: {
      layer: "primitive" | "composed" | "meta";
      dependencies?: string[];
      composition_cues?: string[];
    };
  };
};

export type ExternalProfileDefinition = {
  profile_id: string;
  label: string;
  description: string;
  /** If true, include all tasks from the built-in default profile. Default: false. */
  extends_default?: boolean;
  /** Category weights. Missing categories default to 0 (excluded). */
  category_weights: Record<string, number>;
  /** Custom task definitions. */
  tasks: ExternalTaskDefinition[];
  /**
   * When extends_default is true, exclude these task IDs from the inherited set.
   * Useful for removing default tasks you don't care about.
   */
  exclude_tasks?: string[];
  /**
   * When extends_default is true, exclude all tasks in these categories from the inherited set.
   * Equivalent to removing tasks by category without listing each ID.
   */
  exclude_categories?: string[];
  /** Default trials_per_side for all tasks in this profile. Per-task overrides win. Default: 5. */
  default_trials_per_side?: number;
  /** Optional collapse detection config for composition tasks. Defaults apply if omitted. */
  collapse_config?: CollapseConfig;
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type ProfileValidationError = {
  field: string;
  message: string;
};

export function validateExternalProfile(raw: unknown): ProfileValidationError[] {
  const errors: ProfileValidationError[] = [];

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    errors.push({ field: "root", message: "Profile must be a JSON object." });
    return errors;
  }

  const profile = raw as Record<string, unknown>;

  // Required string fields
  for (const field of ["profile_id", "label", "description"] as const) {
    if (typeof profile[field] !== "string" || (profile[field] as string).trim().length === 0) {
      errors.push({ field, message: `'${field}' must be a non-empty string.` });
    }
  }

  // Category weights
  if (typeof profile.category_weights !== "object" || profile.category_weights === null || Array.isArray(profile.category_weights)) {
    errors.push({ field: "category_weights", message: "'category_weights' must be an object mapping category names to numeric weights." });
  } else {
    const weights = profile.category_weights as Record<string, unknown>;
    const weightEntries = Object.entries(weights);
    if (weightEntries.length === 0) {
      errors.push({ field: "category_weights", message: "'category_weights' must have at least one category." });
    }
    for (const [key, value] of weightEntries) {
      if (typeof value !== "number" || value < 0) {
        errors.push({ field: `category_weights.${key}`, message: `Weight for '${key}' must be a non-negative number. Got: ${value}` });
      }
    }
  }

  // Optional: exclude_tasks
  if (profile.exclude_tasks !== undefined) {
    if (!Array.isArray(profile.exclude_tasks) || !profile.exclude_tasks.every((t: unknown) => typeof t === "string")) {
      errors.push({ field: "exclude_tasks", message: "'exclude_tasks' must be an array of task ID strings." });
    }
  }

  // Optional: exclude_categories
  if (profile.exclude_categories !== undefined) {
    if (!Array.isArray(profile.exclude_categories) || !profile.exclude_categories.every((c: unknown) => typeof c === "string")) {
      errors.push({ field: "exclude_categories", message: "'exclude_categories' must be an array of category name strings." });
    }
  }

  // Optional: default_trials_per_side
  if (profile.default_trials_per_side !== undefined) {
    if (typeof profile.default_trials_per_side !== "number" || profile.default_trials_per_side < 1 || profile.default_trials_per_side > 20) {
      errors.push({ field: "default_trials_per_side", message: "'default_trials_per_side' must be a number between 1 and 20." });
    }
  }

  // Tasks
  if (!Array.isArray(profile.tasks)) {
    errors.push({ field: "tasks", message: "'tasks' must be an array of task definitions." });
  } else {
    const tasks = profile.tasks as unknown[];
    if (tasks.length === 0 && !profile.extends_default) {
      errors.push({ field: "tasks", message: "'tasks' array is empty and extends_default is not true. Profile would have no tasks." });
    }
    const seenIds = new Set<string>();
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      if (typeof task !== "object" || task === null || Array.isArray(task)) {
        errors.push({ field: `tasks[${i}]`, message: "Task must be an object." });
        continue;
      }
      const t = task as Record<string, unknown>;
      if (typeof t.task_id !== "string" || t.task_id.trim().length === 0) {
        errors.push({ field: `tasks[${i}].task_id`, message: "'task_id' must be a non-empty string." });
      } else if (seenIds.has(t.task_id as string)) {
        errors.push({ field: `tasks[${i}].task_id`, message: `Duplicate task_id '${t.task_id}'.` });
      } else {
        seenIds.add(t.task_id as string);
      }
      if (typeof t.category !== "string" || t.category.trim().length === 0) {
        errors.push({ field: `tasks[${i}].category`, message: "'category' must be a non-empty string." });
      }
      if (typeof t.prompt_text !== "string" || t.prompt_text.trim().length === 0) {
        errors.push({ field: `tasks[${i}].prompt_text`, message: "'prompt_text' must be a non-empty string." });
      }
      if (t.mock_cues !== undefined && (!Array.isArray(t.mock_cues) || !t.mock_cues.every((c: unknown) => typeof c === "string"))) {
        errors.push({ field: `tasks[${i}].mock_cues`, message: "'mock_cues' must be an array of strings." });
      }
      if (t.trials_per_side !== undefined && (typeof t.trials_per_side !== "number" || t.trials_per_side < 1 || t.trials_per_side > 20)) {
        errors.push({ field: `tasks[${i}].trials_per_side`, message: "'trials_per_side' must be a number between 1 and 20." });
      }

      // Extension validation
      if (t.extensions !== undefined && typeof t.extensions === "object" && t.extensions !== null) {
        const ext = t.extensions as Record<string, unknown>;
        const taskId = typeof t.task_id === "string" ? t.task_id : `tasks[${i}]`;

        // At-most-one extension
        if (ext.cv && ext.composition) {
          errors.push({ field: `${taskId}.extensions`, message: `Task ${taskId}: at most one extension allowed (has both cv and composition).` });
        }

        // CV extension validation
        if (ext.cv !== undefined && typeof ext.cv === "object" && ext.cv !== null) {
          const cv = ext.cv as Record<string, unknown>;
          const cvErrors = validateCVExtension(cv, taskId);
          errors.push(...cvErrors);

          // Warn if no cv scorer registered
          if (cvErrors.length === 0 && !getRegisteredScorers().some(s => s.kind === "cv")) {
            console.warn(`[watchtower] Task ${taskId} has cv extension but no cv scorer registered. Extension will be skipped; base score used.`);
          }
        }

        // Composition extension validation
        if (ext.composition !== undefined && typeof ext.composition === "object" && ext.composition !== null) {
          const comp = ext.composition as Record<string, unknown>;
          const compErrors = validateCompositionExtension(comp, taskId);
          errors.push(...compErrors);

          // Warn if no composition scorer registered
          if (compErrors.length === 0 && !getRegisteredScorers().some(s => s.kind === "composition")) {
            console.warn(`[watchtower] Task ${taskId} has composition extension but no composition scorer registered. Extension will be skipped; base score used.`);
          }
        }
      }
    }
  }

  // collapse_config validation (profile-level)
  if (profile.collapse_config !== undefined && typeof profile.collapse_config === "object" && profile.collapse_config !== null) {
    const cc = profile.collapse_config as Record<string, unknown>;
    if (typeof cc.primitive_floor !== "number" || cc.primitive_floor < 0 || cc.primitive_floor > 1) {
      errors.push({ field: "collapse_config.primitive_floor", message: "Must be a number in [0, 1]." });
    }
    if (typeof cc.composed_ceiling !== "number" || cc.composed_ceiling < 0 || cc.composed_ceiling > 1) {
      errors.push({ field: "collapse_config.composed_ceiling", message: "Must be a number in [0, 1]." });
    }
    if (typeof cc.primitive_floor === "number" && typeof cc.composed_ceiling === "number"
        && cc.primitive_floor <= cc.composed_ceiling) {
      errors.push({
        field: "collapse_config",
        message: `primitive_floor (${cc.primitive_floor}) must be greater than composed_ceiling (${cc.composed_ceiling}).`,
      });
    }
  }

  // DAG validation across all composition tasks
  if (Array.isArray(profile.tasks)) {
    const compositionNodes: DAGNode[] = [];
    const tasks = profile.tasks as unknown[];
    for (const task of tasks) {
      if (typeof task !== "object" || task === null) continue;
      const t = task as Record<string, unknown>;
      const ext = t.extensions as Record<string, unknown> | undefined;
      if (ext?.composition && typeof ext.composition === "object") {
        const comp = ext.composition as Record<string, unknown>;
        const validLayers: CompositionLayer[] = ["primitive", "composed", "meta"];
        if (typeof t.task_id === "string" && validLayers.includes(comp.layer as CompositionLayer)) {
          compositionNodes.push({
            task_id: t.task_id as string,
            layer: comp.layer as CompositionLayer,
            dependencies: Array.isArray(comp.dependencies) ? comp.dependencies as string[] : [],
          });
        }
      }
    }
    if (compositionNodes.length > 0) {
      try {
        validateCompositionDAG(compositionNodes);
      } catch (err) {
        errors.push({
          field: "composition_dag",
          message: (err as Error).message,
        });
      }
    }

    // Warn if composition tasks exist but no scorer
    if (compositionNodes.length > 0 && !getRegisteredScorers().some(s => s.kind === "composition")) {
      console.warn("[watchtower] Profile has composition tasks but no composition scorer registered.");
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// CV Extension Validation
// ---------------------------------------------------------------------------

function validateCVExtension(cv: Record<string, unknown>, taskId: string): ProfileValidationError[] {
  const errors: ProfileValidationError[] = [];

  // construction_cues: optional but if present must be string[]
  if (cv.construction_cues !== undefined) {
    if (!Array.isArray(cv.construction_cues) || !cv.construction_cues.every((c: unknown) => typeof c === "string")) {
      errors.push({ field: `${taskId}.extensions.cv.construction_cues`, message: "'construction_cues' must be an array of strings." });
    }
  }

  // verification_checks: required, must be array
  if (!Array.isArray(cv.verification_checks)) {
    errors.push({ field: `${taskId}.extensions.cv.verification_checks`, message: "'verification_checks' must be an array." });
  } else {
    const checks = cv.verification_checks as unknown[];
    const seenCheckIds = new Set<string>();
    for (let j = 0; j < checks.length; j++) {
      const check = checks[j] as Record<string, unknown>;
      if (typeof check !== "object" || check === null) {
        errors.push({ field: `${taskId}.extensions.cv.verification_checks[${j}]`, message: "Check must be an object." });
        continue;
      }
      // check_id
      if (typeof check.check_id !== "string" || check.check_id.trim().length === 0) {
        errors.push({ field: `${taskId}.extensions.cv.verification_checks[${j}].check_id`, message: "'check_id' must be a non-empty string." });
      } else if (seenCheckIds.has(check.check_id as string)) {
        errors.push({ field: `${taskId}.extensions.cv.verification_checks[${j}].check_id`, message: `Duplicate check_id '${check.check_id}' in task ${taskId}.` });
      } else {
        seenCheckIds.add(check.check_id as string);
      }
      // weight
      if (typeof check.weight !== "number" || check.weight < 0 || check.weight > 1) {
        errors.push({ field: `${taskId}.extensions.cv.verification_checks[${j}].weight`, message: "'weight' must be a number between 0 and 1." });
      }
      // rule — parse to validate DSL syntax
      if (typeof check.rule === "string") {
        try {
          parseRule(check.rule);
        } catch (err) {
          const msg = err instanceof DSLParseError
            ? `DSL parse error in rule '${check.rule}': ${err.message}`
            : `Invalid rule '${check.rule}'`;
          errors.push({ field: `${taskId}.extensions.cv.verification_checks[${j}].rule`, message: `Task ${taskId}: ${msg}` });
        }
      } else {
        errors.push({ field: `${taskId}.extensions.cv.verification_checks[${j}].rule`, message: "'rule' must be a string." });
      }
    }
  }

  // Weight validation: construction_weight + verification_weight ≈ 1.0
  const cw = typeof cv.construction_weight === "number" ? cv.construction_weight : CV_CONSTRUCTION_WEIGHT_DEFAULT;
  const vw = typeof cv.verification_weight === "number" ? cv.verification_weight : CV_VERIFICATION_WEIGHT_DEFAULT;

  if (typeof cv.construction_weight === "number" && (cv.construction_weight < 0 || cv.construction_weight > 1)) {
    errors.push({ field: `${taskId}.extensions.cv.construction_weight`, message: "'construction_weight' must be between 0 and 1." });
  }
  if (typeof cv.verification_weight === "number" && (cv.verification_weight < 0 || cv.verification_weight > 1)) {
    errors.push({ field: `${taskId}.extensions.cv.verification_weight`, message: "'verification_weight' must be between 0 and 1." });
  }

  const weightSum = cw + vw;
  if (Math.abs(weightSum - 1.0) > 0.01) {
    errors.push({
      field: `${taskId}.extensions.cv`,
      message: `Task ${taskId}: construction_weight + verification_weight = ${weightSum.toFixed(3)}, expected 1.0 (tolerance 0.01).`
    });
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Composition Extension Validation
// ---------------------------------------------------------------------------

function validateCompositionExtension(
  comp: Record<string, unknown>,
  taskId: string
): ProfileValidationError[] {
  const errors: ProfileValidationError[] = [];
  const validLayers: CompositionLayer[] = ["primitive", "composed", "meta"];

  // layer is required and must be valid enum
  if (!comp.layer || !validLayers.includes(comp.layer as CompositionLayer)) {
    errors.push({
      field: `${taskId}.extensions.composition.layer`,
      message: `Must be one of: ${validLayers.join(", ")}.`,
    });
  }

  // dependencies must be string[] if present (default [])
  if (comp.dependencies !== undefined) {
    if (
      !Array.isArray(comp.dependencies) ||
      !comp.dependencies.every((d: unknown) => typeof d === "string")
    ) {
      errors.push({
        field: `${taskId}.extensions.composition.dependencies`,
        message: "Must be a string array.",
      });
    }
  }

  // composition_cues must be string[] if present (default [])
  if (comp.composition_cues !== undefined) {
    if (
      !Array.isArray(comp.composition_cues) ||
      !comp.composition_cues.every((c: unknown) => typeof c === "string")
    ) {
      errors.push({
        field: `${taskId}.extensions.composition.composition_cues`,
        message: "Must be a string array.",
      });
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

function externalTaskToBenchmarkTask(
  ext: ExternalTaskDefinition,
  family: string,
  defaultTrials: number
): BenchmarkTask {
  const trials = ext.trials_per_side ?? defaultTrials;
  return {
    task_id: ext.task_id,
    task_version: 1,
    family,
    category: ext.category as BenchmarkCategory,
    critical_regression: ext.critical_regression ?? false,
    evaluator_kind: ext.evaluator_kind ?? "rubric",
    priority: ext.priority ?? 50,
    min_valid_trials: ext.min_valid_trials ?? Math.max(1, trials - 1),
    trials_per_side: Math.max(1, Math.min(20, trials)),
    prompt_text: ext.prompt_text,
    rubric_text: ext.rubric_text ?? null,
    ...(ext.extensions?.cv ? {
      extensions: {
        cv: {
          construction_cues: ext.extensions.cv.construction_cues ?? [],
          verification_checks: ext.extensions.cv.verification_checks.map(c => ({
            check_id: c.check_id,
            kind: c.kind as CVCheck["kind"],
            description: c.description,
            rule: c.rule,
            weight: c.weight,
            critical: c.critical ?? false,
          })),
          construction_weight: ext.extensions.cv.construction_weight ?? CV_CONSTRUCTION_WEIGHT_DEFAULT,
          verification_weight: ext.extensions.cv.verification_weight ?? CV_VERIFICATION_WEIGHT_DEFAULT,
          firewall: ext.extensions.cv.firewall ?? true,
        } satisfies CVTaskExtension,
      } satisfies TaskExtensions,
    } : ext.extensions?.composition ? {
      extensions: {
        composition: {
          layer: ext.extensions.composition.layer,
          dependencies: ext.extensions.composition.dependencies ?? [],
          composition_cues: ext.extensions.composition.composition_cues ?? [],
        } satisfies CompositionTaskExtension,
      } satisfies TaskExtensions,
    } : {}),
  };
}

/**
 * Build a BenchmarkProfile from an external definition.
 * If extends_default is true, the built-in default tasks are included first,
 * then custom tasks are appended. Category weights are merged (custom overrides built-in).
 */
export function buildProfileFromExternal(def: ExternalProfileDefinition): BenchmarkProfile {
  let tasks: BenchmarkTask[] = [];
  let mergedWeights: Record<string, number> = { ...def.category_weights };
  const defaultTrials = def.default_trials_per_side ?? 5;

  if (def.extends_default) {
    const base = getBenchmarkProfile("default");
    let inherited = [...base.tasks];

    // Apply exclusions
    const excludeTaskSet = new Set(def.exclude_tasks ?? []);
    const excludeCategorySet = new Set((def.exclude_categories ?? []).map((c) => c.toLowerCase().trim()));

    inherited = inherited.filter((t) => {
      if (excludeTaskSet.has(t.task_id)) return false;
      if (excludeCategorySet.has(t.category)) return false;
      return true;
    });

    // Apply default_trials_per_side override to inherited tasks (explicit override, not fallback)
    if (def.default_trials_per_side !== undefined) {
      tasks = inherited.map((t) => ({ ...t, trials_per_side: def.default_trials_per_side! }));
    } else {
      tasks = inherited;
    }

    // Merge: custom weights override, built-in weights fill gaps
    mergedWeights = { ...BUILTIN_CATEGORY_WEIGHTS, ...def.category_weights };

    // Remove weights for excluded categories
    for (const cat of excludeCategorySet) {
      delete mergedWeights[cat];
    }
  }

  // Append custom tasks (overwrite if same task_id exists in base)
  const customTasks = def.tasks.map((t) => externalTaskToBenchmarkTask(t, def.profile_id, defaultTrials));
  const existingIds = new Set(tasks.map((t) => t.task_id));
  for (const ct of customTasks) {
    if (existingIds.has(ct.task_id)) {
      tasks = tasks.map((t) => (t.task_id === ct.task_id ? ct : t));
    } else {
      tasks.push(ct);
    }
  }

  // Validate: every task's category must have a weight
  const categoriesInTasks = new Set(tasks.map((t) => t.category));
  for (const cat of categoriesInTasks) {
    if (!(cat in mergedWeights)) {
      throw new Error(
        `Task category '${cat}' has no weight in category_weights. ` +
        `Either add a weight for '${cat}' or remove tasks in that category.`
      );
    }
  }

  // Filter weights to only include categories that have tasks
  const activeWeights: Record<string, number> = {};
  for (const [cat, weight] of Object.entries(mergedWeights)) {
    if (categoriesInTasks.has(cat)) {
      activeWeights[cat] = weight;
    }
  }

  return {
    profile_id: def.profile_id,
    label: def.label,
    description: def.description,
    tasks,
    pack: {
      pack_id: `${def.profile_id}-custom-pack`,
      source: "built_in_pack",
      task_ids: tasks.map((t) => t.task_id),
      category_weights: activeWeights,
      critical_task_ids: tasks.filter((t) => t.critical_regression).map((t) => t.task_id),
      catalog_hash: computeBenchmarkPackHash(tasks)
    },
    collapse_config: def.collapse_config
  };
}

// ---------------------------------------------------------------------------
// File loading
// ---------------------------------------------------------------------------

/**
 * Load a profile from a JSON file on disk.
 * Validates the file contents and returns a ready-to-use BenchmarkProfile.
 */
export function loadProfileFromFile(filePath: string): BenchmarkProfile {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Profile file not found: ${absPath}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(absPath, "utf8"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse profile file ${absPath}: ${msg}`);
  }

  const errors = validateExternalProfile(raw);
  if (errors.length > 0) {
    const details = errors.map((e) => `  ${e.field}: ${e.message}`).join("\n");
    throw new Error(`Invalid profile file ${absPath}:\n${details}`);
  }

  return buildProfileFromExternal(raw as ExternalProfileDefinition);
}

// ---------------------------------------------------------------------------
// Mock cue registry (extensible)
// ---------------------------------------------------------------------------

/**
 * Global registry of mock executor cue keywords by task ID prefix or exact ID.
 * Custom profiles can register cues for their tasks so the mock executor
 * produces meaningful (non-generic) scores.
 */
const MOCK_CUE_REGISTRY = new Map<string, string[]>();

export function registerMockCues(taskIdOrPrefix: string, cues: string[]): void {
  MOCK_CUE_REGISTRY.set(taskIdOrPrefix, cues);
}

export function lookupMockCues(taskId: string): string[] | undefined {
  // Exact match first
  const exact = MOCK_CUE_REGISTRY.get(taskId);
  if (exact) return exact;

  // Prefix match (longest wins)
  let bestMatch: string[] | undefined;
  let bestLength = 0;
  for (const [prefix, cues] of MOCK_CUE_REGISTRY) {
    if (taskId.startsWith(prefix) && prefix.length > bestLength) {
      bestMatch = cues;
      bestLength = prefix.length;
    }
  }
  return bestMatch;
}

/**
 * Register mock cues from an external profile definition.
 * Called automatically when loading a profile file that includes mock_cues on tasks.
 */
export function registerMockCuesFromProfile(def: ExternalProfileDefinition): void {
  for (const task of def.tasks) {
    if (task.mock_cues && task.mock_cues.length > 0) {
      registerMockCues(task.task_id, task.mock_cues);
    }
  }
}

// ---------------------------------------------------------------------------
// Category subsetting
// ---------------------------------------------------------------------------

/**
 * Create a narrowed profile that only includes tasks from the specified categories.
 * Weights are preserved for included categories; excluded categories are dropped.
 */
export function subsetProfileByCategories(
  profile: BenchmarkProfile,
  categories: string[]
): BenchmarkProfile {
  const categorySet = new Set(categories.map((c) => c.toLowerCase().trim()));
  const filteredTasks = profile.tasks.filter((t) => categorySet.has(t.category));

  if (filteredTasks.length === 0) {
    const available = [...new Set(profile.tasks.map((t) => t.category))].join(", ");
    throw new Error(
      `No tasks match categories: ${categories.join(", ")}. Available categories: ${available}`
    );
  }

  const filteredWeights: Record<string, number> = {};
  for (const [cat, weight] of Object.entries(profile.pack.category_weights)) {
    if (categorySet.has(cat)) {
      filteredWeights[cat] = weight;
    }
  }

  return {
    ...profile,
    profile_id: `${profile.profile_id}:subset`,
    label: `${profile.label} (subset: ${categories.join(", ")})`,
    tasks: filteredTasks,
    pack: {
      ...profile.pack,
      pack_id: `${profile.pack.pack_id}-subset`,
      task_ids: filteredTasks.map((t) => t.task_id),
      category_weights: filteredWeights,
      critical_task_ids: filteredTasks.filter((t) => t.critical_regression).map((t) => t.task_id),
      catalog_hash: computeBenchmarkPackHash(filteredTasks)
    }
  };
}
