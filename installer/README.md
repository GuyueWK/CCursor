# @cometix/ccursor

Cursor++ BYOK Installer — Bring Your Own Key for Cursor IDE.

## Install

```bash
npx @cometix/ccursor install
```

## Uninstall

```bash
npx @cometix/ccursor uninstall
```

## Status

```bash
npx @cometix/ccursor status
```

## Notes

- **After every Cursor update, re-run `install`** — updates overwrite the patched bundles.
- **Cursor 3.23+ (especially Remote-SSH):** if agents fail with
  `AI Model Not Found / Model name is not valid: "<id>"`, re-run `install` and restart Cursor.
  The installer forces Cursor's `cursor_agent_host` topology back to the `legacy`
  implementation, which restores Cursor++'s interception of agent requests.
