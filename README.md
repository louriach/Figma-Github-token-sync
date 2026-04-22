# Figma GitHub Token Sync

A Figma plugin that bi-directionally syncs your Figma variables to and from a JSON file stored in a GitHub or GitLab repository. Token files follow the [W3C Design Token Community Group (DTCG)](https://design-tokens.github.io/community-group/format/) specification.

---

## Features

- **Push** — export all Figma variable collections to your repo as W3C-compliant JSON
- **Pull** — import token JSON from your repo and create or update Figma variables
- **Multi-mode support** — Light/Dark (and any other modes) are preserved in the token files
- **Variable aliases** — references between variables are stored as `{group.token.name}` and round-trip correctly
- **Auto repo/branch picker** — connect your token once to browse repos and branches without typing
- **Branch creation** — if the target branch doesn't exist, the plugin creates it from your default branch on first push
- **Secure** — your PAT is stored only in Figma's local `clientStorage`, never transmitted anywhere except the provider API over HTTPS
- **GitLab ready** — provider abstraction makes switching to GitLab a single setting change

---

## Token file format

One JSON file is written per Figma variable collection, placed in the configured tokens directory (default: `tokens/`).

### Single-mode collection

```json
{
  "spacing": {
    "4": { "$value": 16, "$type": "number", "$description": "16px" },
    "8": { "$value": 32, "$type": "number" }
  }
}
```

### Multi-mode collection (e.g. Light / Dark)

```json
{
  "$metadata": {
    "collection": "Colors",
    "modes": ["Light", "Dark"]
  },
  "Light": {
    "brand": {
      "primary": { "$value": "#0066CC", "$type": "color" }
    }
  },
  "Dark": {
    "brand": {
      "primary": { "$value": "#3B82F6", "$type": "color" }
    }
  }
}
```

### Variable aliases

Aliases between variables are stored as W3C references:

```json
{
  "semantic": {
    "background": { "$value": "{neutral.0}", "$type": "color" }
  }
}
```

### Supported token types

| Figma type | W3C `$type` |
|---|---|
| `COLOR` | `color` |
| `FLOAT` | `number` |
| `STRING` | `string` |
| `BOOLEAN` | `boolean` |

---

## Getting started

### 1. Create a Personal Access Token

**GitHub** — go to [Settings → Personal access tokens → Fine-grained tokens](https://github.com/settings/personal-access-tokens/new) and create a token with:
- **Repository access**: the specific repo you want to sync
- **Permissions**: Contents → Read and Write

**GitLab** — go to Preferences → Access Tokens and create a token with the `api` scope.

> Using a fine-grained token scoped to a single repository is strongly recommended over a classic token with broad `repo` access.

### 2. Install the plugin

1. Clone or download this repository
2. In Figma, go to **Plugins → Development → Import plugin from manifest**
3. Select the `manifest.json` file from this repo
4. Run `npm install && npm run build` first to generate the `dist/` files

### 3. Configure

On first open the plugin shows the settings screen:

1. Select your provider (GitHub or GitLab)
2. Paste your PAT and click **Connect** — your repositories load automatically
3. Select the repository from the dropdown
4. Pick or type a branch name (it will be created if it doesn't exist)
5. Set the tokens path (default: `tokens/`)
6. Click **Save settings** — the plugin switches to the Sync tab

Settings are saved locally in Figma. You won't need to re-enter them next time.

---

## Usage

### Push (Figma → GitHub)

Exports every variable collection in the current Figma file as a separate JSON file in your tokens directory. Existing files are updated in place (no duplicate commits).

### Pull (GitHub → Figma)

Downloads all JSON files from the tokens directory and imports them as Figma variable collections. Existing collections and variables are updated; new ones are created.

---

## Development

```bash
npm install

# one-off build
npm run build

# watch mode (rebuilds on save)
npm run watch
```

Output goes to `dist/`. The plugin `manifest.json` points to `dist/code.js` and `dist/ui.html`.

### Project structure

```
src/
  code.ts          # Figma plugin main thread — reads/writes variables, clientStorage
  ui.tsx           # React UI — settings, sync, logging
  ui.html          # HTML shell
  types.ts         # Shared types (W3C tokens, messages, settings)
  lib/
    provider.ts    # GitProvider interface
    github.ts      # GitHub REST API implementation
    gitlab.ts      # GitLab REST API implementation
    tokens.ts      # Figma ↔ W3C DTCG conversion logic
tokens/
  colors.json      # Sample multi-mode colour tokens
  spacing.json     # Sample spacing/radius tokens
  typography.json  # Sample typography tokens
```

---

## Roadmap

- [ ] Conflict detection (warn when remote has changed since last pull)
- [ ] Selective collection sync (choose which collections to push/pull)
- [ ] OAuth flow (avoid manual PAT creation)
- [ ] Support for Bitbucket
- [ ] VS Code extension using the same token format

---

## License

MIT
