# SharpKit

A VS Code extension that makes day-to-day .NET development feel closer to
JetBrains Rider — without leaving VS Code.

It focuses on the parts of the workflow where VS Code has historically been
weakest for .NET developers: **launching projects in one click**, seeing
**errors grouped by project**, running **EF Core migrations** from a UI, and
a few other niceties (watch mode, attach to process, test runner,
`launchSettings.json` editor, pre-launch hooks).

It **does not** reimplement IntelliSense, refactorings, or navigation —
those are handled by **C# Dev Kit** (Microsoft) and **ReSharper for VS
Code** (JetBrains). SharpKit sits next to them and owns the project /
run / debug / tooling experience.

---

## What you get

Three dedicated views appear in the activity bar under a rocket icon:

### Launchable Projects

A **Solution → Project** tree of your workspace. Every `.sln` / `.slnx`
is listed, each expands to show all the projects it contains. Launchable
projects (executables, web APIs, workers, Blazor, Razor) get inline
buttons; libraries are shown so you have the full picture but aren't
clickable for run.

Inline actions adapt to the project's current state:

| State       | Buttons                             |
|-------------|-------------------------------------|
| Idle        | **Run ▶**, **Debug 🐞**, **Watch 👁** |
| Running     | **Stop ⏹**                          |
| Debugging   | **Pause ⏸**, **Stop ⏹**             |
| Paused      | **Continue ▶**, **Stop ⏹**          |
| Testing     | **Stop ⏹**                          |

Behind the scenes:
- **Run** → `dotnet run --project …` via the VS Code tasks API (so you
  get problem matchers and cancellation for free).
- **Debug** → synthesizes a `coreclr` debug configuration in memory and
  hands it to `vscode.debug.startDebugging`. Your `launch.json` is never
  touched.
- **Watch** → `dotnet watch run …` for hot-reload web/worker loops.
- **Pause / Continue / Stop** → the built-in VS Code debug commands,
  scoped to the project's session.
- **Test projects** (detected via `Microsoft.NET.Test.Sdk`, xUnit,
  NUnit, MSTest) get **Run Tests** and **Debug Tests** instead.
  Debug Tests auto-attaches the debugger as soon as the VSTest host
  prints its PID.

Right-click a solution or project node for **Build / Rebuild / Clean /
Restore**, and right-click a project for **Edit launchSettings.json**
(opens a webview form over the JSON — per-profile tabs, env variable
grid, save/revert).

The view title has two extra buttons: **Refresh** and **Attach to .NET
process** (opens a quick-pick of running `dotnet` processes and
attaches the debugger).

### Problems by Project

A second tree that takes all diagnostics from the language server and
regroups them **Project → File → Diagnostic**, with per-project error
and warning counts. Clicking a diagnostic jumps straight to the line.
Filterable via `sharpkit.includeWarnings`.

SharpKit does not produce diagnostics — it consumes whatever C# Dev Kit
or the Roslyn LSP emits. Same source of truth as VS Code's native
Problems panel, just reorganized so "which project is red?" is one
glance away.

### EF Core Migrations

A Rider-style tool window for Entity Framework Core projects:

- Each `.csproj` with an `Microsoft.EntityFrameworkCore` reference
  appears as a top-level node.
- Under it, each detected `DbContext` class (including ones inheriting
  from `IdentityDbContext<…>` etc.) becomes a child node.
- Inline actions on both DbContext **and** project nodes:
  - **Add Migration** — prompts for a name, runs `dotnet ef migrations add`.
  - **Update Database** — runs `dotnet ef database update`, optional target.
  - **Remove Last Migration** — runs `dotnet ef migrations remove` with a
    confirm dialog.

If auto-detection misses a context, the QuickPick includes an
"Enter name manually…" option. First time you use it, SharpKit checks
for `dotnet-ef` and offers to install it globally.

---

## Pre-launch hooks

Configure per-project commands that run before Run / Debug / Watch /
Tests. Useful for starting a Docker container, running a migration, or
warming a cache.

```jsonc
// .vscode/settings.json or user settings
"sharpkit.preLaunch": {
  "src/MyService/MyService.csproj": [
    { "name": "Start Postgres",    "command": "docker compose up -d db" },
    { "name": "Apply migrations",  "command": "dotnet ef database update", "cwd": "src/MyService" }
  ]
}
```

Keys can be absolute or workspace-relative csproj paths. Hooks run
sequentially; if one fails, you get a **Continue anyway / Abort**
prompt.

---

## Settings

| Setting                         | Default       | Purpose |
|---------------------------------|---------------|---------|
| `sharpkit.includeWarnings`      | `true`        | Include warnings in the Problems by Project view. |
| `sharpkit.defaultLaunchProfile` | `""`          | Preferred `launchSettings.json` profile when a project has several. |
| `sharpkit.suppressWarnings`     | `["CS1591"]`  | C# warning codes suppressed across all SharpKit dotnet invocations (build / run / watch / test). Translated to MSBuild `NoWarn=`. |
| `sharpkit.preLaunch`            | `{}`          | Per-project pre-launch hook table (see above). |

---

## Requirements

- **VS Code 1.90+**
- **.NET SDK 6.0 or newer** on `PATH` (tested on 8.0 and 10.0).
- **C# Dev Kit** or any C# language server (recommended, for the
  Problems by Project view — SharpKit consumes diagnostics, it does not
  produce them).
- Optional: **`dotnet-ef`** global tool for migrations (SharpKit will
  prompt to install).
- Optional: **`dotnet-trace`** global tool for process listing on
  Attach (falls back to `ps` / `tasklist` if missing).

---

## Installing from source

Until a Marketplace build exists:

```bash
git clone <repo-url> sharpkit
cd sharpkit
npm install
npm run build
```

Then from VS Code:
1. Open the `sharpkit` folder.
2. Press **F5** to launch an **Extension Development Host** — a second
   VS Code window with SharpKit loaded.
3. Open a .NET solution in that window.

---

## Known limitations

- **Multi-solution workspaces**: all solutions are shown side-by-side.
  If C# Dev Kit pops its own "Workspace or Solution" picker, that's
  its dialog — dismiss it or set `dotnet.defaultSolution`. SharpKit
  operates on every solution in the workspace regardless.
- **Debug Tests** relies on `VSTEST_HOST_DEBUG` and parses the PID
  from stdout. If the test host suppresses that line (rare), the
  auto-attach won't fire.
- **Attach to process** attaches without binding to a tree node;
  state on running projects in the tree is unaffected.
- **EF Core** migrations assume startup project == migration project.
  Split-project setups aren't yet surfaced in the UI (use the CLI for
  now, or open an issue).

---

## Architecture & contributing

The extension is written in **TypeScript**, bundled with **esbuild**,
no runtime dependencies beyond `vscode` itself. Source lives under
`src/` with a clear split: `solution/` parses `.sln` / `.csproj`,
`launch/` owns the run/debug/watch/test/attach state machine,
`migrations/` covers EF Core, `ui/` holds the three TreeDataProviders
and the launchSettings webview, `actions/` has the build commands,
`services/` centralizes logging and dotnet CLI plumbing.

```bash
npm run compile   # tsc --noEmit (type check)
npm run build     # esbuild production bundle
npm run watch     # esbuild watch mode for iterative dev
```

---

## License

MIT.
