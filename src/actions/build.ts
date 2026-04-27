import * as path from "path";
import { Project } from "../solution/discovery";
import { Solution } from "../solution/slnParser";
import { runDotnetTaskAndWait, getSuppressedWarningsArg } from "../services/dotnetCli";
import { showError } from "../services/logger";

export type BuildTarget =
  | { kind: "solution"; solution: Solution }
  | { kind: "project"; project: Project };

function targetPath(target: BuildTarget): string {
  return target.kind === "solution" ? target.solution.path : target.project.csprojPath;
}

function targetName(target: BuildTarget): string {
  return target.kind === "solution"
    ? path.basename(target.solution.path)
    : target.project.name;
}

function targetCwd(target: BuildTarget): string {
  return target.kind === "solution" ? target.solution.directory : target.project.directory;
}

async function runDotnet(
  command: string,
  target: BuildTarget,
  extraArgs: string[] = [],
): Promise<number | undefined> {
  try {
    return await runDotnetTaskAndWait({
      name: `${capitalize(command)} ${targetName(target)}`,
      args: [command, targetPath(target), ...getSuppressedWarningsArg(), ...extraArgs],
      cwd: targetCwd(target),
      taskType: `sharpkit-${command}`,
      definition: { target: targetPath(target) },
    });
  } catch (err) {
    await showError(`dotnet ${command} failed for ${targetName(target)}`, err);
    return undefined;
  }
}

export function build(target: BuildTarget): Promise<number | undefined> {
  return runDotnet("build", target);
}

export function clean(target: BuildTarget): Promise<number | undefined> {
  return runDotnet("clean", target);
}

export function restore(target: BuildTarget): Promise<number | undefined> {
  return runDotnet("restore", target);
}

export function publish(target: BuildTarget, outputDir?: string): Promise<number | undefined> {
  const extra = outputDir ? ["-o", outputDir] : [];
  return runDotnet("publish", target, extra);
}

export async function rebuild(target: BuildTarget): Promise<number | undefined> {
  const cleanCode = await runDotnet("clean", target);
  if (cleanCode !== 0) {
    return cleanCode;
  }
  return runDotnet("build", target);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
