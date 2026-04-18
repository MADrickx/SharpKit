import * as cp from "child_process";
import * as os from "os";
import * as vscode from "vscode";
import { execDotnet, ensureDotnetTool } from "../services/dotnetCli";
import { showError, log } from "../services/logger";

export interface DotnetProcess {
  pid: number;
  name: string;
  commandLine: string;
}

export async function attachToDotnetProcess(): Promise<void> {
  const processes = await listDotnetProcesses();
  if (processes.length === 0) {
    const installed = await ensureDotnetTool(["trace", "--help"], "dotnet-trace", "dotnet-trace");
    if (!installed) {
      vscode.window.showWarningMessage("No running .NET processes found.");
      return;
    }
    const retry = await listDotnetProcesses();
    if (retry.length === 0) {
      vscode.window.showWarningMessage("No running .NET processes found.");
      return;
    }
  }

  const fresh = processes.length > 0 ? processes : await listDotnetProcesses();
  const picked = await vscode.window.showQuickPick(
    fresh.map((p) => ({
      label: p.name,
      description: `pid ${p.pid}`,
      detail: p.commandLine,
      process: p,
    })),
    {
      placeHolder: "Select a .NET process to attach to",
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );
  if (!picked) {
    return;
  }

  const config: vscode.DebugConfiguration = {
    type: "coreclr",
    request: "attach",
    name: `SharpKit attach: ${picked.process.name}`,
    processId: picked.process.pid,
    __sharpkitAttached: true,
  };

  try {
    const started = await vscode.debug.startDebugging(undefined, config);
    if (!started) {
      await showError(`Failed to attach to ${picked.process.name} (pid ${picked.process.pid}).`);
    }
  } catch (err) {
    await showError(`Failed to attach to ${picked.process.name}`, err);
  }
}

export async function listDotnetProcesses(): Promise<DotnetProcess[]> {
  const fromTrace = await listViaDotnetTrace();
  if (fromTrace.length > 0) {
    return fromTrace;
  }
  return listViaPlatformPs();
}

async function listViaDotnetTrace(): Promise<DotnetProcess[]> {
  const { stdout, code } = await execDotnet(["trace", "ps"]);
  if (code !== 0) {
    return [];
  }
  const results: DotnetProcess[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    const match = /^(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    results.push({
      pid: Number(match[1]),
      name: match[2],
      commandLine: match[3],
    });
  }
  return results;
}

function listViaPlatformPs(): Promise<DotnetProcess[]> {
  const isWin = os.platform() === "win32";
  return isWin ? listWindows() : listUnix();
}

function listUnix(): Promise<DotnetProcess[]> {
  return new Promise((resolve) => {
    cp.execFile("ps", ["-A", "-o", "pid=,command="], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        log.warn("ps failed", err);
        resolve([]);
        return;
      }
      const results: DotnetProcess[] = [];
      for (const raw of stdout.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) {
          continue;
        }
        const match = /^(\d+)\s+(.*)$/.exec(line);
        if (!match) {
          continue;
        }
        const command = match[2];
        if (!/\b(dotnet|\.dll|\.exe)\b/i.test(command)) {
          continue;
        }
        if (/\/(Code|code|cursor)\//.test(command)) {
          continue;
        }
        results.push({
          pid: Number(match[1]),
          name: extractProcessName(command),
          commandLine: command,
        });
      }
      resolve(results);
    });
  });
}

function listWindows(): Promise<DotnetProcess[]> {
  return new Promise((resolve) => {
    cp.execFile("tasklist", ["/FO", "CSV", "/NH"], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        log.warn("tasklist failed", err);
        resolve([]);
        return;
      }
      const results: DotnetProcess[] = [];
      for (const raw of stdout.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) {
          continue;
        }
        const cols = line.split(/","/).map((c) => c.replace(/^"|"$/g, ""));
        if (cols.length < 2) {
          continue;
        }
        const name = cols[0];
        const pid = Number(cols[1]);
        if (!Number.isFinite(pid)) {
          continue;
        }
        if (!/dotnet|\.exe/i.test(name)) {
          continue;
        }
        results.push({ pid, name, commandLine: cols.join(" ") });
      }
      resolve(results);
    });
  });
}

function extractProcessName(commandLine: string): string {
  const parts = commandLine.split(/\s+/);
  const first = parts[0] ?? commandLine;
  const base = first.split(/[\\/]/).pop() ?? first;
  const dll = parts.find((p) => p.endsWith(".dll"));
  if (dll) {
    return dll.split(/[\\/]/).pop() ?? base;
  }
  return base;
}
