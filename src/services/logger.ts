import * as vscode from "vscode";

let channel: vscode.OutputChannel | undefined;

export function initLogger(context: vscode.ExtensionContext): vscode.OutputChannel {
  channel = vscode.window.createOutputChannel("SharpKit");
  context.subscriptions.push(channel);
  return channel;
}

function write(level: string, msg: string, ...args: unknown[]): void {
  if (!channel) {
    return;
  }
  const ts = new Date().toISOString();
  const extras = args.length ? " " + args.map((a) => safeStringify(a)).join(" ") : "";
  channel.appendLine(`[${ts}] [${level}] ${msg}${extras}`);
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) {
    return value.stack ?? value.message;
  }
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const log = {
  info: (msg: string, ...args: unknown[]) => write("info", msg, ...args),
  warn: (msg: string, ...args: unknown[]) => write("warn", msg, ...args),
  error: (msg: string, ...args: unknown[]) => write("error", msg, ...args),
};

export async function showError(message: string, err?: unknown): Promise<void> {
  log.error(message, err);
  const pick = await vscode.window.showErrorMessage(message, "Show logs");
  if (pick === "Show logs") {
    channel?.show(true);
  }
}
