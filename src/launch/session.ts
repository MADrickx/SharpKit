import * as cp from "child_process";
import * as vscode from "vscode";
import { Project, LaunchProfile } from "../solution/discovery";
import { log, showError } from "../services/logger";
import { runPreLaunchHooks } from "./hooks";
import { getSuppressedWarningsArg } from "../services/dotnetCli";

export type SessionState = "idle" | "running" | "debugging" | "paused" | "watching" | "testing";

interface ProjectSession {
  state: SessionState;
  taskExecution?: vscode.TaskExecution;
  debugSession?: vscode.DebugSession;
  childProcess?: cp.ChildProcess;
}

type LaunchMode = "run" | "watch" | "test";

const TASK_TYPES: Record<LaunchMode, string> = {
  run: "sharpkit-run",
  watch: "sharpkit-watch",
  test: "sharpkit-test-run",
};

const STATE_FOR_TASK: Record<LaunchMode, SessionState> = {
  run: "running",
  watch: "watching",
  test: "testing",
};

export class SessionManager implements vscode.Disposable {
  private readonly sessions = new Map<string, ProjectSession>();
  private readonly onChangeEmitter = new vscode.EventEmitter<string>();
  readonly onDidChangeState = this.onChangeEmitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  private testOutputChannel: vscode.OutputChannel | undefined;

  constructor() {
    this.disposables.push(
      vscode.debug.onDidStartDebugSession((s) => this.handleDebugStart(s)),
      vscode.debug.onDidTerminateDebugSession((s) => this.handleDebugEnd(s)),
      vscode.tasks.onDidStartTask((e) => this.handleTaskStart(e.execution)),
      vscode.tasks.onDidEndTask((e) => this.handleTaskEnd(e.execution)),
      vscode.debug.registerDebugAdapterTrackerFactory("coreclr", {
        createDebugAdapterTracker: (session) => this.createTracker(session),
      }),
    );
  }

  getState(projectPath: string): SessionState {
    return this.sessions.get(projectPath)?.state ?? "idle";
  }

  async run(project: Project, profile?: LaunchProfile): Promise<void> {
    await this.launchTask(project, "run", profile);
  }

  async watch(project: Project, profile?: LaunchProfile): Promise<void> {
    await this.launchTask(project, "watch", profile);
  }

  async runTests(project: Project): Promise<void> {
    await this.launchTask(project, "test");
  }

  private async launchTask(project: Project, mode: LaunchMode, profile?: LaunchProfile): Promise<void> {
    if (this.getState(project.csprojPath) !== "idle") {
      vscode.window.showInformationMessage(`${project.name} is already running. Stop it first.`);
      return;
    }

    const hooksOk = await runPreLaunchHooks(project);
    if (!hooksOk) {
      return;
    }

    const args = buildDotnetArgs(mode, project, profile);
    const label = taskLabel(mode, project, profile);

    const task = new vscode.Task(
      { type: TASK_TYPES[mode], project: project.csprojPath, profile: profile?.name },
      vscode.TaskScope.Workspace,
      label,
      "SharpKit",
      new vscode.ShellExecution("dotnet", args, { cwd: project.directory }),
      "$msCompile",
    );
    task.presentationOptions = {
      reveal: vscode.TaskRevealKind.Always,
      panel: vscode.TaskPanelKind.Dedicated,
      clear: true,
    };

    try {
      const execution = await vscode.tasks.executeTask(task);
      this.setState(project.csprojPath, { state: STATE_FOR_TASK[mode], taskExecution: execution });
    } catch (err) {
      await showError(`Failed to ${mode} ${project.name}`, err);
    }
  }

  async debug(project: Project, profile?: LaunchProfile): Promise<void> {
    if (this.getState(project.csprojPath) !== "idle") {
      vscode.window.showInformationMessage(`${project.name} is already running. Stop it first.`);
      return;
    }

    const hooksOk = await runPreLaunchHooks(project);
    if (!hooksOk) {
      return;
    }

    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(project.directory));
    const tfm = project.targetFrameworks[0] ?? "net8.0";
    const programPath = `${project.directory}/bin/Debug/${tfm}/${project.assemblyName}.dll`;

    const config: vscode.DebugConfiguration = {
      type: "coreclr",
      request: "launch",
      name: `SharpKit: ${project.name}`,
      program: programPath,
      cwd: profile?.workingDirectory ?? project.directory,
      env: profile?.environmentVariables,
      stopAtEntry: false,
      console: "internalConsole",
      preLaunchTask: undefined,
      __sharpkitProjectPath: project.csprojPath,
    };

    if (profile?.applicationUrl) {
      config.env = { ...(config.env ?? {}), ASPNETCORE_URLS: profile.applicationUrl };
    }

    try {
      const started = await vscode.debug.startDebugging(folder, config);
      if (!started) {
        await showError(`Failed to start debugger for ${project.name}.`);
        return;
      }
      this.setState(project.csprojPath, { state: "debugging" });
    } catch (err) {
      await showError(`Failed to debug ${project.name}`, err);
    }
  }

  async debugTests(project: Project): Promise<void> {
    if (this.getState(project.csprojPath) !== "idle") {
      vscode.window.showInformationMessage(`${project.name} is already running. Stop it first.`);
      return;
    }

    const hooksOk = await runPreLaunchHooks(project);
    if (!hooksOk) {
      return;
    }

    const channel = this.getTestChannel();
    channel.show(true);
    channel.appendLine(`[${new Date().toISOString()}] dotnet test ${project.name} (VSTEST_HOST_DEBUG)`);

    const child = cp.spawn(
      "dotnet",
      ["test", project.csprojPath, "--no-build", ...getSuppressedWarningsArg()],
      {
        cwd: project.directory,
        env: { ...process.env, VSTEST_HOST_DEBUG: "1" },
      },
    );

    this.setState(project.csprojPath, { state: "testing", childProcess: child });

    let attached = false;
    const handleStdout = (buf: Buffer) => {
      const text = buf.toString();
      channel.append(text);
      if (attached) {
        return;
      }
      const match = /Process Id:\s*(\d+)/i.exec(text);
      if (match) {
        attached = true;
        const pid = Number(match[1]);
        this.attachToTestHost(project, pid).catch((err) => showError(`Failed to attach test host for ${project.name}`, err));
      }
    };

    child.stdout?.on("data", handleStdout);
    child.stderr?.on("data", (buf: Buffer) => channel.append(buf.toString()));
    child.on("exit", (code) => {
      channel.appendLine(`\n[exit ${code ?? "?"}] ${project.name}`);
      this.setState(project.csprojPath, { state: "idle" });
    });
    child.on("error", (err) => {
      showError(`dotnet test spawn failed for ${project.name}`, err).catch(() => {});
      this.setState(project.csprojPath, { state: "idle" });
    });
  }

  private async attachToTestHost(project: Project, pid: number): Promise<void> {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(project.directory));
    const config: vscode.DebugConfiguration = {
      type: "coreclr",
      request: "attach",
      name: `SharpKit test: ${project.name}`,
      processId: pid,
      __sharpkitProjectPath: project.csprojPath,
    };
    await vscode.debug.startDebugging(folder, config);
  }

  async stop(project: Project): Promise<void> {
    const session = this.sessions.get(project.csprojPath);
    if (!session) {
      return;
    }
    if (session.debugSession) {
      await vscode.debug.stopDebugging(session.debugSession);
    }
    if (session.taskExecution) {
      session.taskExecution.terminate();
    }
    if (session.childProcess && !session.childProcess.killed) {
      session.childProcess.kill();
    }
    this.setState(project.csprojPath, { state: "idle" });
  }

  async pause(project: Project): Promise<void> {
    const session = this.sessions.get(project.csprojPath);
    if (!session?.debugSession) {
      return;
    }
    await vscode.commands.executeCommand("workbench.action.debug.pause");
  }

  async continueExecution(project: Project): Promise<void> {
    const session = this.sessions.get(project.csprojPath);
    if (!session?.debugSession) {
      return;
    }
    await vscode.commands.executeCommand("workbench.action.debug.continue");
  }

  private getTestChannel(): vscode.OutputChannel {
    if (!this.testOutputChannel) {
      this.testOutputChannel = vscode.window.createOutputChannel("SharpKit — Tests");
      this.disposables.push(this.testOutputChannel);
    }
    return this.testOutputChannel;
  }

  private handleDebugStart(session: vscode.DebugSession): void {
    const key = projectKeyFromSession(session);
    if (key) {
      const existing = this.sessions.get(key);
      this.setState(key, { ...(existing ?? { state: "idle" }), state: "debugging", debugSession: session });
    }
  }

  private handleDebugEnd(session: vscode.DebugSession): void {
    const key = projectKeyFromSession(session);
    if (key && this.sessions.has(key)) {
      const existing = this.sessions.get(key)!;
      if (existing.state === "testing" || existing.childProcess) {
        this.setState(key, { ...existing, debugSession: undefined });
        return;
      }
      this.setState(key, { state: "idle" });
      return;
    }
    for (const [k, s] of this.sessions) {
      if (s.debugSession?.id === session.id) {
        this.setState(k, { ...s, debugSession: undefined, state: s.childProcess ? s.state : "idle" });
      }
    }
  }

  private handleTaskStart(execution: vscode.TaskExecution): void {
    const def = execution.task.definition as { type?: string; project?: string };
    if (!def.project || !isSharpKitLaunchType(def.type)) {
      return;
    }
    const mode = modeForTaskType(def.type as string);
    if (!mode) {
      return;
    }
    this.setState(def.project, { state: STATE_FOR_TASK[mode], taskExecution: execution });
  }

  private handleTaskEnd(execution: vscode.TaskExecution): void {
    const def = execution.task.definition as { type?: string; project?: string };
    if (!def.project || !isSharpKitLaunchType(def.type)) {
      return;
    }
    this.setState(def.project, { state: "idle" });
  }

  private createTracker(session: vscode.DebugSession): vscode.DebugAdapterTracker {
    return {
      onDidSendMessage: (message) => {
        if (message?.type !== "event") {
          return;
        }
        const key = this.findKeyBySessionId(session.id);
        if (!key) {
          return;
        }
        const existing = this.sessions.get(key);
        if (!existing) {
          return;
        }
        if (message.event === "stopped") {
          this.setState(key, { ...existing, state: "paused" });
        } else if (message.event === "continued") {
          this.setState(key, { ...existing, state: "debugging" });
        }
      },
    };
  }

  private findKeyBySessionId(sessionId: string): string | undefined {
    for (const [key, s] of this.sessions) {
      if (s.debugSession?.id === sessionId) {
        return key;
      }
    }
    return undefined;
  }

  private setState(projectPath: string, session: ProjectSession): void {
    if (session.state === "idle") {
      this.sessions.delete(projectPath);
    } else {
      this.sessions.set(projectPath, session);
    }
    log.info(`Session ${projectPath} → ${session.state}`);
    this.onChangeEmitter.fire(projectPath);
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.onChangeEmitter.dispose();
  }
}

function buildDotnetArgs(mode: LaunchMode, project: Project, profile?: LaunchProfile): string[] {
  const suppress = getSuppressedWarningsArg();
  if (mode === "test") {
    return ["test", project.csprojPath, ...suppress];
  }
  const base = mode === "watch" ? ["watch", "run"] : ["run"];
  const args = [...base, "--project", project.csprojPath];
  if (profile) {
    args.push("--launch-profile", profile.name);
  }
  return [...args, ...suppress];
}

function taskLabel(mode: LaunchMode, project: Project, profile?: LaunchProfile): string {
  const prefix = mode === "watch" ? "Watch" : mode === "test" ? "Test" : "Run";
  return `${prefix} ${project.name}${profile ? ` (${profile.name})` : ""}`;
}

function isSharpKitLaunchType(type: string | undefined): boolean {
  return type === "sharpkit-run" || type === "sharpkit-watch" || type === "sharpkit-test-run";
}

function modeForTaskType(type: string): LaunchMode | undefined {
  if (type === "sharpkit-run") return "run";
  if (type === "sharpkit-watch") return "watch";
  if (type === "sharpkit-test-run") return "test";
  return undefined;
}

function projectKeyFromSession(session: vscode.DebugSession): string | undefined {
  const tag = (session.configuration as { __sharpkitProjectPath?: unknown })["__sharpkitProjectPath"];
  return typeof tag === "string" ? tag : undefined;
}
