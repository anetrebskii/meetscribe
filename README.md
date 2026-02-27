# MeetScribe

Chrome extension for live Google Meet transcription with meeting history.

![Chrome](https://img.shields.io/badge/Chrome-Extension-blue)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-green)

## Features

- **Live transcription** — real-time captions captured directly from Google Meet
- **Speaker identification** — automatic attribution via RTC device tracking and DOM correlation
- **Smart merging** — consecutive messages from the same speaker within 30 seconds are combined into a single entry
- **Meeting history** — all meetings are saved locally with participants, timestamps, and full transcripts
- **Floating popup** — draggable, resizable overlay on the Meet page with auto-scroll
- **24 languages** — English, Spanish, Portuguese, French, German, Russian, Japanese, Chinese, and more
- **Export formats** — Markdown, plain text, JSON, SRT, and VTT
- **Copy to clipboard** — one-click copy as Markdown

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

1. Join a Google Meet call — captions are enabled and captured automatically
2. Click the MeetScribe icon in the toolbar to toggle the floating transcript popup
3. Use the sidebar popup to browse past meetings, rename them, or export

### Export

Click the export button on any meeting to download as Markdown. Files are named `Title YYYYMMDDHHmm.md`.

### Language

Use the language selector in the floating popup to switch transcription language. The setting persists across sessions.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Save meetings, transcripts, and settings locally |
| `activeTab` | Detect when you're on Google Meet |
| `scripting` | Inject transcript capture into Meet pages |
| `tabs` | Track tab changes for popup routing |
| `host_permissions: meet.google.com` | Only runs on Google Meet |

All data stays in your browser. Nothing is sent to external servers.
