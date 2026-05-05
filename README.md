# Personal Pi Extensions

Personal collection of pi coding agent extensions, skills, and configurations.

## Installation

```bash
pi install git:github.com/zacheryph/pi
```

Or add to your `~/.pi/agent/settings.json`:

```json
{
  "packages": ["git:github.com/zacheryph/pi"]
}
```

## Extensions

### opencode-editor

A custom editor styled like opencode with:

- Dark gray background (ANSI 256 color 236)
- Left accent bar tracking thinking level + bash mode
- 4-char left padding, 3-char right padding inside the box
- Autocomplete menu floats above the editor

## Development

Add new extensions to the `extensions/` directory. They will be automatically discovered by pi.

## License

MIT
