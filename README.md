# clanker-stats

See how many tokens you've burned across AI coding tools.

![chart](https://github.com/dnakov/clanker-stats/raw/main/chart.png)

## Usage

```
npx clanker-stats
```

Generates `chart.png` in the current directory and opens it.

### Share on X

```
npx clanker-stats --share
```

Copies the chart to your clipboard, opens X with a pre-filled post. Just paste and post.

## Supported tools

| Tool | Data source |
|------|------------|
| Claude Code | `~/.claude/projects/` |
| Codex | `~/.codex/sessions/` |
| OpenCode | `~/.local/share/opencode/` |
| Gemini CLI | `~/.gemini/tmp/` |
| Amp | `~/.local/share/amp/threads/` |
| Pi | `~/.pi/agent/sessions/` |
| Mistral Vibe | `~/.vibe/logs/session/` |
