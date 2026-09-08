# Notula for Google Meet

Chrome extension for live Google Meet transcription with meeting history.

![Chrome](https://img.shields.io/badge/Chrome-Extension-blue)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-green)

## Features

- **Live transcription** - real-time captions captured directly from Google Meet
- **Speaker identification** - automatic attribution via RTC device tracking and DOM correlation
- **Smart merging** - consecutive messages from the same speaker within 30 seconds are combined into a single entry
- **Meeting history** - all meetings are saved locally with participants, timestamps, and full transcripts
- **Floating popup** - draggable, resizable overlay on the Meet page with auto-scroll
- **31 languages** - English, Spanish, Portuguese, French, German, Russian, Japanese, Chinese, and more
- **Export formats** - Markdown, plain text, JSON, SRT, and VTT
- **Copy to clipboard** - one-click copy as Markdown
- **Save to a Git repo** - optional, via [Notula Desktop](https://notula.org). Pick a repository and a folder, and a finished call is written there as ordinary Markdown

## Install

### From Release

1. Download the latest `.zip` from [Releases](../../releases)
2. Unzip to a folder
3. Open `chrome://extensions/`
4. Enable **Developer mode** (top right)
5. Click **Load unpacked** and select the unzipped folder

### From Source

```bash
npm install
npm run build
```

Then load the project root as an unpacked extension (same steps 3-5 above).

## Usage

1. Join a Google Meet call - captions are enabled and captured automatically
2. Click the Notula icon in the toolbar to toggle the floating transcript popup
3. Use the sidebar popup to browse past meetings, rename them, or export

### Export

Click the export button on any meeting to download as Markdown. Files are named `Title YYYYMMDDHHmm.md`.

### Language

Use the language selector in the floating popup to switch transcription language. The setting persists across sessions.

## Saving into a Git repository

This is optional and the extension does everything above without it.

[Notula](https://notula.org) is a desktop Markdown editor that works on a folder in a Git repository. When it is running on the same machine, this extension can hand it a finished call and Notula writes it into that folder as an ordinary Markdown file with YAML frontmatter - no id, no anchor, no sidecar. Delete Notula afterwards and the meetings are a folder of readable notes.

1. Install and open Notula, with the repository you want open in it
2. In the extension, press **Save to your Git repo via Notula**
3. Notula shows a six-character code; check it matches the one in the extension and accept
4. Pick a repository and a folder. `meetings/` is the default. The choice is remembered per meeting code, so a recurring call is only asked once

Notula does not commit or push. The file lands in the working tree and what happens to it is yours.

### How it talks to Notula

Notula listens on `127.0.0.1`, on the first free port of `51789..51796`, and the extension probes those eight in order and remembers the one that answered. **No new browser permission is required for this** - the permissions table below is unchanged from before the feature existed.

The server only answers a request whose `Origin` is a `chrome-extension://` one, pairing hands out a token that every later call has to carry, and Notula only ever touches a path it wrote itself.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Save meetings, transcripts, and settings locally |
| `activeTab` | Detect when you're on Google Meet |
| `scripting` | Inject transcript capture into Meet pages |
| `tabs` | Track tab changes for popup routing |
| `host_permissions: meet.google.com` | Only runs on Google Meet |

All data stays in your browser. Nothing is sent to an external server: transcription is Google Meet's own caption system, no audio is recorded and no bot joins the call.

The only network request this extension makes is to `127.0.0.1` when you have turned on saving to a Git repo, and that reaches Notula on your own machine and nothing else.
