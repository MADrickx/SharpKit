import * as cp from "child_process";
import * as vscode from "vscode";
import { log } from "./logger";

export function getSuppressedWarningsArg(): string[] {
  const codes = vscode.workspace
    .getConfiguration("sharpkit")
    .get<string[]>("suppressWarnings", ["CS1591"]);
  if (!Array.isArray(codes) || codes.length === 0) {
    return [];
  }
  const cleaned = codes
    .map((c) => String(c).trim().replace(/^CS/i, ""))
    .filter((c) => /^\d+$/.test(c));
  if (cleaned.length === 0) {
    return [];
  }
  return [`-p:NoWarn=${cleaned.join(";")}`];
}

export interface DotnetTaskOptions {
  name: string;
  args: string[];
  cwd?: string;
  taskType: string;
  definition?: Record<string, unknown>;
  env?: Record<string, string>;
  problemMatcher?: string | string[];
  scope?: vscode.WorkspaceFolder | vscode.TaskScope;
  presentation?: vscode.TaskPresentationOptions;
}

export function buildDotnetTask(opts: DotnetTaskOptions): vscode.Task {
  const execution = new vscode.ShellExecution("dotnet", opts.args, {
    cwd: opts.cwd,
    env: opts.env,
  });
  const task = new vscode.Task(
    { type: opts.taskType, ...(opts.definition ?? {}) },
    opts.scope ?? vscode.TaskScope.Workspace,
    opts.name,
    "SharpKit",
    execution,
    opts.problemMatcher ?? "$msCompile",
  );
  task.presentationOptions = opts.presentation ?? {
    reveal: vscode.TaskRevealKind.Always,
    panel: vscode.TaskPanelKind.Dedicated,
    clear: true,
  };
  return task;
}

export async function runDotnetTaskAndWait(
  opts: DotnetTaskOptions,
): Promise<number | undefined> {
  const task = buildDotnetTask(opts);
  const execution = await vscode.tasks.executeTask(task);
  return new Promise<number | undefined>((resolve) => {
    const disposable = vscode.tasks.onDidEndTaskProcess((e) => {
      if (e.execution === execution) {
        disposable.dispose();
        resolve(e.exitCode);
      }
    });
  });
}

export function execDotnet(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    cp.execFile("dotnet", args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: number }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ stdout: String(stdout), stderr: String(stderr), code });
    });
  });
}

export async function ensureDotnetTool(
  toolCheckArgs: string[],
  toolName: string,
  packageId: string,
): Promise<boolean> {
  const { code } = await execDotnet(toolCheckArgs);
  if (code === 0) {
    return true;
  }
  const pick = await vscode.window.showErrorMessage(
    `${toolName} is not installed. Install as a global dotnet tool?`,
    "Install",
    "Cancel",
  );
  if (pick !== "Install") {
    return false;
  }
  log.info(`Installing ${packageId} globally`);
  const exitCode = await runDotnetTaskAndWait({
    name: `Install ${toolName}`,
    args: ["tool", "install", "--global", packageId],
    taskType: "sharpkit-tool-install",
  });
  if (exitCode !== 0) {
    vscode.window.showErrorMessage(`Failed to install ${toolName} (exit ${exitCode}).`);
    return false;
  }
  return true;
}
