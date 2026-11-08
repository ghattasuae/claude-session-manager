# Claude Session Manager

Every Claude Code session on your machine, in a VS Code sidebar, one click away from a terminal.

I run four or five Claude Code terminals in VS Code at once: one per feature, one for a bug hunt, one next to `npm run dev:local`. Then the machine reboots, VS Code comes back with empty terminals, and I spend ten minutes digging through `/resume` lists and session ids trying to remember which conversation was which. Claude Session Manager fixes that. It lists every session, lets you give each one a name you will recognize, reopens any of them with one click, and brings the whole terminal layout back after a restart.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.90.0-007ACC?logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com/)
[![Built with Claude Code](https://img.shields.io/badge/built%20with-Claude%20Code-D97757)](https://claude.com/claude-code)

<!-- Screenshot to be added: save a capture of the sidebar as docs/screenshot.png -->
![Claude Session Manager sidebar](docs/screenshot.png)

## Features

### Sessions list and one-click resume

- Sessions are grouped by project folder. Folders that belong to the open workspace come first and are expanded.
- Each session shows its title, how long ago it was active and its git branch. Hover for the first prompt, the folder and the session id.
- A green dot marks sessions that are running right now.
- Click a session to open a terminal in its folder and resume it. If the extension already opened that session, the existing terminal is focused instead of opening a second one.
- Right click for Rename, Open in New Terminal (fork with `--fork-session`), Copy Session ID, Reveal Transcript File and Hide Session.
- The toolbar has Refresh, Search (by title, first prompt or project), Restore Last Layout and a filter for the current workspace only.

### Rename sessions

Select a session and press `F2`, or right click and choose Rename. The name shows in the sidebar and is passed to Claude as `--name` the next time you open the session, so the terminal title, Claude's prompt box and its `/resume` picker all agree. Leave the box empty to go back to Claude's own title. Transcript files are never modified.

### Custom terminals

Save any command you run often, for example `npm run dev:local` in a specific folder, with the `+` button in the Custom Terminals view. Click it to open its terminal, or focus it if it is already open. Edit, duplicate, reorder and delete from the right click menu.

### Layout restore

While you work, the extension remembers which Claude sessions and custom terminals are open in each workspace. When VS Code starts again it offers to reopen all of them, a few hundred milliseconds apart so each shell is ready before the next one starts. You can also run Restore Last Layout at any time. A custom terminal can be left out of restores with Toggle Include in Layout Restore.

### How a click turns into a terminal

Clicking a session opens a new VS Code terminal in the session's folder and runs:

```sh
claude --resume '<id>' --name '<your title>'
```

`--name` is only added when you have renamed the session. The session id is checked to be a UUID, and your title is single-quote escaped for zsh, bash and fish. Anything in `claudeSessions.extraArgs` is appended at the end, and Open in New Terminal adds `--fork-session`.

## Quick start

1. Download `claude-session-manager-0.1.0.vsix` from the [GitHub Releases page](https://github.com/ghattasuae/claude-session-manager/releases), or build it yourself (see below).
2. Install it: in VS Code open the Extensions view, click the `...` menu, choose Install from VSIX and pick the file. Or run `code --install-extension claude-session-manager-0.1.0.vsix`.
3. Open the Claude Sessions icon in the activity bar.

You need the [Claude Code CLI](https://claude.com/claude-code) installed and on your PATH (or set `claudeSessions.claudePath`).

### Build from source

```sh
git clone https://github.com/ghattasuae/claude-session-manager.git
cd claude-session-manager
npm install
npm run build
npm run package
code --install-extension claude-session-manager-0.1.0.vsix
```

On macOS, if the `code` command is not on your PATH, use `"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"`.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `claudeSessions.claudePath` | `claude` | Path or command name of the Claude Code CLI used to resume sessions. User settings only (ignored in workspace settings). |
| `claudeSessions.extraArgs` | (empty) | Extra arguments appended verbatim to every `claude --resume` command (for example `--model opus`). User settings only (ignored in workspace settings). |
| `claudeSessions.autoRestore` | `prompt` | What to do on startup when a saved layout exists and none of it is open. `off` never restores, `prompt` asks, `always` restores immediately. |
| `claudeSessions.currentWorkspaceOnly` | `false` | Only show projects that belong to the open workspace folders. |
| `claudeSessions.maxSessionsPerProject` | `50` | Maximum number of sessions listed per project (newest first). |
| `claudeSessions.projectsDir` | `~/.claude/projects` | Folder that holds the Claude Code session transcripts. User settings only (ignored in workspace settings). |

`claudePath`, `extraArgs` and `projectsDir` are ignored in workspace settings so that a cloned repository cannot change the command that runs in your terminal.

## Commands and keyboard shortcuts

All commands are in the Command Palette under the "Claude Sessions" category.

| Command | Where | Shortcut |
| --- | --- | --- |
| Refresh | Sessions toolbar, palette | |
| Search Sessions | Sessions toolbar, palette | |
| Restore Last Layout | Sessions and Custom Terminals toolbars, palette | |
| Show Current Workspace Only / Show All Projects | Sessions toolbar, palette | |
| Show Hidden Sessions / Stop Showing Hidden Sessions | Sessions `...` menu, palette | |
| Open Session | Click a session, inline button, right click | |
| Open in New Terminal (Fork Session) | Right click on a session | |
| Rename Session | Right click on a session, palette | `F2` (Sessions view focused) |
| Copy Session ID | Right click on a session | |
| Reveal Transcript File | Right click on a session | |
| Hide Session / Unhide Session | Right click on a session | |
| Add Custom Terminal | Custom Terminals toolbar, palette | |
| Open Custom Terminal | Click a custom terminal, inline button, right click | |
| Edit, Duplicate, Delete | Right click on a custom terminal | |
| Move Up, Move Down | Right click on a custom terminal | |
| Toggle Include in Layout Restore | Right click on a custom terminal | |

## How it works

- **Transcripts.** Sessions are read from `~/.claude/projects/<project>/<session>.jsonl`. Only the first and last 64 KB of each file are read, and results are cached until the file changes, so large transcripts stay cheap.
- **Live sessions.** Running sessions come from Claude Code's registry in `~/.claude/sessions`, checked every few seconds while the view is open. Entries whose process has exited are ignored.
- **Titles.** The first match wins: your own name from this extension, then the name set with `/rename` in Claude, then Claude's automatic title, then the first prompt, then the start of the session id.
- **State.** Names, hidden sessions and custom terminals are stored in VS Code `globalState`. The last layout is stored in `workspaceState` (or `globalState` when no folder is open).
- **Read only.** The extension never writes to `~/.claude`.
- **Offline.** No network access and no telemetry. Everything stays on your machine.

## Privacy and safety

- Transcripts are only read locally, and only the parts needed to show a title and a first prompt. Nothing leaves your machine.
- The only commands the extension runs are the ones you can see: `claude --resume` for sessions and the exact commands you saved as custom terminals, typed into a normal VS Code terminal.
- Settings that control what runs (`claudePath`, `extraArgs`, `projectsDir`) are honored only from user settings, so opening an untrusted repository cannot change them.

## FAQ

**Does it work with the official Claude Code extension?**
Yes. This extension is independent. It reads the same session files and opens sessions in regular terminals, so both can be installed side by side.

**Does it work outside VS Code?**
No. It is a VS Code extension and needs the VS Code terminal and sidebar.

**Why is a session missing?**
Empty sessions (no prompt and no title) are skipped. Sessions you hid are not listed either; use Show Hidden Sessions in the Sessions view `...` menu to see them. Also check `claudeSessions.currentWorkspaceOnly` and `claudeSessions.maxSessionsPerProject`.

**Can I change the `claude` binary?**
Yes. Set `claudeSessions.claudePath` in your user settings to a full path or another command name.

**Does restore reopen sessions started in iTerm?**
Sessions that are running anywhere on the machine show up in the live registry and get a green dot. Restore does not resume a session that is still running elsewhere, so you never get two copies of the same conversation. Once that process exits, the session can be resumed normally.

## Roadmap

- Add real screenshots and a short demo GIF.
- Publish to the VS Code Marketplace.
- Pin favorite sessions to the top of the list.
- Better grouping and filtering in multi-root workspaces.
- Test and polish on Windows (PowerShell and cmd quoting).

## Contributing

Issues and pull requests are welcome. To work on the extension:

```sh
npm install
npm run watch
```

Then open the folder in VS Code and press `F5` to launch the Extension Development Host with the extension loaded. Run `npm run build` before sending a pull request to make sure it builds and type checks.

## License

[MIT](LICENSE)
