import { BenchmarkTask } from "./schemas.js";
import { sha256Bytes } from "./files.js";

export function computeTaskHash(task: BenchmarkTask): string {
  return sha256Bytes(
    [
      `${task.task_id}:${task.task_version}`,
      JSON.stringify(task),
      task.prompt_text,
      task.rubric_text ?? ""
    ].join("\n---\n")
  );
}

export function computeBenchmarkPackHash(tasks: BenchmarkTask[]): string {
  return sha256Bytes(
    [...tasks]
      .sort((a, b) => a.task_id.localeCompare(b.task_id))
      .map((task) => computeTaskHash(task))
      .join("\n")
  );
}
