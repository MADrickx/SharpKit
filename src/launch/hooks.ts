import * as path from "path";
import * as vscode from "vscode";
import { Project } from "../solution/discovery";
import { log, showError } from "../services/logger";

export interface PreLaunchHook {
  name: string;
  command: string;
  cwd?: string;
  waitForExit?: boolean;
}

export async function runPreLaunchHooks(project: Project): Promise<boolean> {
  const hooks = getHooksForProject(project);
  if (hooks.length === 0) {
    return true;
  }

  log.info(`Running ${hooks.length} pre-launch hook(s) for ${project.name}`);
  for (const hook of hooks) {
    const ok = await runHook(project, hook);
    if (!ok) {
      return false;
    }
  }
  return true;
}

function getHooksForProject(project: Project): PreLaunchHook[] {
  const config = vscode.workspace.getConfiguration("sharpkit");
  const map = config.get<Record<string, PreLaunchHook[]>>("preLaunch", {}) ?? {};
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(project.directory));
  const folderRoot = folder?.uri.fsPath ?? "";

  for (const [key, value] of Object.entries(map)) {
    if (!Array.isArray(value)) {
      continue;
    }
    const absolute = path.isAbsolute(key) ? key : path.resolve(folderRoot, key);
    if (path.normalize(absolute) === path.normalize(project.csprojPath)) {
      return value;
    }
  }
  return [];
}

async function runHook(project: Project, hook: PreLaunchHook): Promise<boolean> {
  const scope = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(project.directory)) ?? vscode.TaskScope.Workspace;
  const task = new vscode.Task(
    { type: "sharpkit-hook", project: project.csprojPath, name: hook.name },
    scope,
    `Pre-launch: ${hook.name}`,
    "SharpKit",
    new vscode.ShellExecution(hook.command, { cwd: hook.cwd ?? project.directory }),
  );
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Silent,
    panel: vscode.TaskPanelKind.Dedicated,
    clear: false,
  };

  try {
    const execution = await vscode.tasks.executeTask(task);
    if (hook.waitForExit === false) {
      return true;
    }
    const exitCode = await new Promise<number | undefined>((resolve) => {
      const disposable = vscode.tasks.onDidEndTaskProcess((e) => {
        if (e.execution === execution) {
          disposable.dispose();
          resolve(e.exitCode);
        }
      });
    });
    if (exitCode !== 0 && exitCode !== undefined) {
      const pick = await vscode.window.showErrorMessage(
        `Pre-launch hook "${hook.name}" failed (exit ${exitCode}).`,
        "Continue anyway",
        "Abort",
      );
      return pick === "Continue anyway";
    }
    return true;
  } catch (err) {
    await showError(`Pre-launch hook "${hook.name}" threw`, err);
    return false;
  }
}
