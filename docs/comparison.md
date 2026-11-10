# Godot MCP Servers with Runtime Support, Compared

There are now well over a hundred Model Context Protocol servers for Godot, most of them forks or weekend experiments, and picking one is harder than it should be because the marketing collapses several different capabilities into the single word "runtime." This page separates them and covers the ~20 most notable, with a source for every claim. It's maintained by the author of [Godot MCP Runtime](https://github.com/Erodenn/godot-mcp-runtime), so read the verdicts with that in mind, but the data comes from each project's own repo, docs, and the GitHub API, and corrections are welcome via [issue](https://github.com/Erodenn/godot-mcp-runtime/issues).

Last updated July 2026.

## What "runtime" actually means

The word gets stretched across three very different capabilities, and a server that has one often gets marketed as if it has all three:

- **File/editor-level.** The server reads and writes your `.tscn` and `.gd` files as text, and it may launch the editor and read the debug console. It never interacts with a running game. This is most servers.
- **Editor-live.** The server manipulates the running Godot _editor_ in real time: you watch nodes appear and properties change in the open editor. Useful for authoring, but the game still isn't running.
- **Game-runtime.** The server interacts with a running _game instance_: it screenshots actual gameplay, injects input, runs GDScript against the live scene tree, and reads runtime errors with backtraces. This is the level that lets an agent press play and check its own work, and it's the one the "can the AI test the game" question is really asking about.

Most comparisons blur editor-live and game-runtime together. They are not the same, and this page marks each server for which one it actually does.

## The footprint axis

A server that reaches a running game has to get code into that game, and how it does that is the axis the marketing skips. There are three ways:

- **Committed addon.** You copy a plugin or autoload into your project, register it, and commit it to version control. It becomes a dependency you maintain, and it ships in your repo.
- **Custom engine.** You download and run a modified engine binary instead of stock Godot, and the runtime lives inside that engine.
- **Zero footprint.** The server injects a bridge transiently when it launches the game and removes it on shutdown, restoring `project.godot`. Nothing is committed, nothing is installed, and you keep running stock Godot.

Full game-runtime and a zero-footprint install rarely come together, and the section below on that niche is where Godot MCP Runtime sits.

## The field

Runtime column: **Game** = interacts with the running game (screenshots/input/live scene tree/script exec), **Game (partial)** = runs the game and reads runtime errors but no gameplay screenshots/input, **Editor** = editor-live, **File** = file/editor-level, **Debugger** = DAP breakpoints/variables only.

| Server                                                                           | Runtime        | How it connects                               | Footprint                          | Stock Godot | License                       | Price                 | Stars | Last activity      |
| -------------------------------------------------------------------------------- | -------------- | --------------------------------------------- | ---------------------------------- | ----------- | ----------------------------- | --------------------- | ----- | ------------------ |
| [Godot MCP Runtime](https://github.com/Erodenn/godot-mcp-runtime)                | **Game**       | Injected TCP bridge autoload, auto-cleanup    | **Zero** (`npx`)                   | Yes         | MIT                           | Free                  | 42    | 2026-07-06         |
| [Coding-Solo/godot-mcp](https://github.com/Coding-Solo/godot-mcp)                | File           | Headless ops, launches editor                 | Zero (`npx`)                       | Yes         | MIT                           | Free                  | 4,578 | 2026-04-16         |
| [hi-godot/godot-ai](https://github.com/hi-godot/godot-ai)                        | Editor         | WebSocket to editor plugin + Python server    | Committed addon + server           | Yes         | MIT                           | Free                  | 868   | 2026-07-06         |
| [ee0pdt/Godot-MCP](https://github.com/ee0pdt/Godot-MCP)                          | File           | Editor plugin + Node server                   | Committed addon                    | Yes         | MIT                           | Free                  | 592   | 2025-03-19 (stale) |
| [Godot MCP Pro](https://godotengine.org/asset-library/asset/4961)                | Game           | WebSocket editor plugin                       | Committed addon                    | Yes         | Proprietary                   | $15                   | 473   | 2026-06-24         |
| [DaxianLee/godot-mcp](https://github.com/DaxianLee/godot-mcp)                    | Game (partial) | In-editor HTTP addon                          | Committed addon                    | Yes         | Non-commercial                | Free                  | 477   | 2026-01-14         |
| [tomyud1/godot-mcp](https://github.com/tomyud1/godot-mcp)                        | Game (partial) | WebSocket inside editor + `npx`               | Committed addon + server           | Yes         | MIT                           | Free                  | 385   | 2026-04-21         |
| [yurineko73/Godot-MCP-Native](https://github.com/yurineko73/Godot-MCP-Native)    | Game           | Native GDScript HTTP/stdio, no sidecar        | Committed addon (no external deps) | Yes         | MIT                           | Free                  | 381   | 2026-07-03         |
| [tugcantopaloglu/godot-mcp](https://github.com/tugcantopaloglu/godot-mcp)        | Game           | TCP autoload on `:9090`                       | Committed addon                    | Yes         | MIT                           | Free                  | 316   | 2026-03-07         |
| [HaD0Yun/GoPeak](https://github.com/HaD0Yun/Doyunha-Gopeak)                      | Game           | `npx` CLI + optional runtime addon; LSP + DAP | Standalone + optional addon        | Yes         | MIT                           | Free                  | 227   | 2026-06-23         |
| [fennara-godot-ai](https://github.com/fennaraOfficial/fennara-godot-ai)          | Game           | Addon + CLI + local daemon                    | Committed addon + daemon           | Yes         | MIT                           | Free                  | 191   | 2026-07-06         |
| [IvanMurzak/Godot-MCP](https://github.com/IvanMurzak/Godot-MCP)                  | Game (opt-in)  | C# addon over SignalR                         | Committed addon (.NET only)        | Yes (mono)  | Apache-2.0                    | Free                  | 163   | 2026-06-30         |
| [satelliteoflove/godot-mcp](https://github.com/satelliteoflove/godot-mcp)        | Game           | WebSocket + debugger protocol                 | Committed addon + server           | Yes         | MIT                           | Free                  | 117   | 2026-07-03         |
| [GDAI MCP](https://gdaimcp.com)                                                  | Editor         | Paid editor plugin drives the editor          | Committed addon (paid)             | Yes         | Proprietary                   | $19                   | 92    | 2026-03-30         |
| [wangdiandao/godot-devtool](https://github.com/wangdiandao/godot-devtool)        | Game           | Bundled WebSocket plugin                      | Committed addon                    | Yes         | MIT                           | Free                  | 88    | 2026-06-29         |
| [Dokujaa/Godot-MCP](https://github.com/Dokujaa/Godot-MCP)                        | File           | Editor plugin + Python server                 | Committed addon                    | Yes         | Unspecified                   | Free                  | 50    | 2026-07-02         |
| [Summer Engine](https://www.summerengine.com/mcp)                                | Game           | Talks to a custom engine on `localhost:6550`  | Custom engine + sign-in            | No          | MIT layer; proprietary engine | Free core, paid cloud | 21    | 2026-07-04         |
| [godot-dap-mcp-server](https://github.com/TransitionMatrix/godot-dap-mcp-server) | Debugger       | Godot's built-in Debug Adapter Protocol       | Zero (Go binary)                   | Yes         | MIT                           | Free                  | 4     | 2025-12-05         |
| [Vollkorn-Games/godot-mcp](https://github.com/Vollkorn-Games/godot-mcp)          | **Game**       | Injected transient TCP autoload, auto-cleanup | **Zero** (build from source)       | Yes         | MIT                           | Free                  | 2     | 2026-06-21         |
| [n24q02m/better-godot-mcp](https://github.com/n24q02m/better-godot-mcp)          | File           | `.tscn` text parsing                          | Zero (`npx`/Docker)                | Yes         | MIT                           | Free                  | 27    | 2026-07-05         |

Star counts track age and reach, not capability. Coding-Solo has by far the largest following and no game-runtime at all, while several of the game-runtime servers sit in the low hundreds or below.

## The zero-footprint game-runtime niche

Two servers combine full game-runtime control with a zero-footprint install, and they arrived there independently at the same time. Godot MCP Runtime and [Vollkorn-Games/godot-mcp](https://github.com/Vollkorn-Games/godot-mcp) both inject a temporary TCP autoload into the running game, drive it, and remove the autoload on shutdown, restoring `project.godot`. Vollkorn's own README puts it plainly: "run_interactive injects a TCP server into the running game as a temporary autoload... Everything is cleaned up automatically when the game stops, the injected autoload is removed and project.godot is restored." The two projects landed their first game-runtime tools within a day of each other in late February 2026, with no shared code, which is about the strongest evidence you get that transient injection is the natural way to do zero-footprint runtime rather than one project's trick.

They differ in maturity and reach rather than concept. Godot MCP Runtime is published to npm and runs from a single `npx godot-mcp-runtime` with no build step, is actively maintained across several releases, and adds a one-time confirmation before the first launch and the first `run_script` on a project, plus a full headless editing suite, an attach mode for games launched outside MCP, and a background mode. Vollkorn is an earlier-stage project with no npm package (you clone the repo and run `pnpm build`), no releases, and no activity since spring 2026. If you want the approach today with the least friction and the most complete tool set, Godot MCP Runtime is the more finished of the two; Vollkorn is worth knowing about as the other honest occupant of this niche.

## Where the notable ones fit

**Coding-Solo/godot-mcp** is the most-starred server in the space and the foundation Godot MCP Runtime's headless operations were built on. It is a clean, MIT, zero-footprint `npx` server that edits files, launches the editor, and captures debug output, and it does not interact with the running game. It is the reference file-level implementation, and it has spawned over 400 forks, most of them inert.

**hi-godot/godot-ai** (sometimes listed as "Godot Studio") is the highest-star Godot MCP server found, with a broad editor-live toolset and one-click configuration for 19+ MCP clients. It manipulates the open editor in real time but does not drive a running game, so it is authoring-focused rather than test-focused. It ships opt-out anonymous telemetry.

**Summer Engine** is the most capable runtime environment in the list, and it is not stock Godot. You download a customized Godot-based engine of roughly a gigabyte, sign in, and the server talks to that engine on `localhost:6550`. The agent layer is MIT; the engine binary is proprietary and free, and hosted AI and asset generation are paid. If you want an all-in-one AI game environment and will adopt a non-stock engine and an account, it is the deepest option; if you want your existing stock-Godot project untouched, it is the wrong shape.

**tugcantopaloglu/godot-mcp** is the closest peer on raw game-runtime capability against stock Godot, with a TCP autoload, live GDScript eval, and runtime error capture across 149 self-reported tools. Its runtime half only works once you copy its autoload into your project and register it, so the bridge is a committed dependency rather than a transient injection.

**yurineko73/Godot-MCP-Native** is notable for being pure GDScript with no external Node or Python sidecar, and it does real game-runtime work including screenshots, input, and breakpoints. It still installs as an addon committed to the project, so it trades the external dependency for an in-repo one.

**satelliteoflove/godot-mcp** takes the most distinctive runtime approach: deterministic playtesting that freezes and steps the game clock and returns live JSON entity-state digests instead of screenshots, with input and scenario injection over the debugger protocol. It requires an installed addon, and it is worth a close read for anyone who cares about reproducible automated play.

**Godot MCP Pro** and **GDAI MCP** are the polished commercial options, at $15 and $19 one-time. Both install an editor-plugin addon and are closed source; Pro does game-runtime including record-and-replay, while GDAI is editor-mediated. **IvanMurzak/Godot-MCP** is the strong open (Apache-2.0) choice for C#/.NET projects, addon-based with opt-in runtime error capture. **GoPeak** and **fennara** are actively developed newer servers that add game-runtime plus extras (GoPeak bundles LSP and DAP; fennara does patch-and-rerun loops), both addon-based.

## The long tail

Beyond the servers above there are roughly ninety more Godot MCP repositories, and including every one would pad this page without helping anyone choose. Most are forks of Coding-Solo/godot-mcp (its network has 400+ forks, nearly all with zero stars and no commits after the fork) or personal experiments under a handful of stars. A few carry real ideas worth a mention: **DaxianLee/godot-mcp** (477 stars, a non-commercial license, and the parent of several further forks), **Glade-tool/glade-mcp** (a multi-engine Unity-and-Godot connector), **bradypp/godot-mcp** (a clean file-level `npx` server, now stale), and a cluster of docs-only RAG servers (**nuskey8/godot-docs-mcp**, **tkmct/godot-doc-mcp**) that answer engine-documentation questions rather than touching a project. You can see the full set via GitHub's [`godot mcp` search](https://github.com/search?q=godot+mcp&type=repositories). If one of them belongs in the main table, [open an issue](https://github.com/Erodenn/godot-mcp-runtime/issues).

## Methodology

Every capability claim comes from the project's own README, docs, site, or asset-library page, and every runtime and footprint classification was checked against those sources in July 2026. Star counts and last-activity dates are from the GitHub API on the same date. Tool counts (149, 163, and similar) are vendor self-reported and not independently audited. Closed-source servers (GDAI MCP, Godot MCP Pro) have runtime mechanisms taken from their own documentation rather than inspected code. The "editor-live" versus "game-runtime" distinction is my own classification, applied from each project's documented tools; where a project's docs were ambiguous I erred toward the weaker claim. If something here is wrong or out of date, [open an issue](https://github.com/Erodenn/godot-mcp-runtime/issues) and it will be corrected.
