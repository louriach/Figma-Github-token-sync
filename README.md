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

### 1. Register a GitHub OAuth App

The plugin uses GitHub's Device Flow so users never have to create or copy a token manually.

1. Go to [github.com/settings/developers → OAuth Apps → New OAuth App](https://github.com/settings/developers)
2. Fill in the form:
   - **Application name**: Figma GitHub Token Sync
   - **Homepage URL**: `https://github.com/louriach/Figma-Github-token-sync`
   - **Authorization callback URL**: `https://github.com` (Device Flow doesn't use this, but the field is required)
3. Click **Register application**
4. On the app page, click **Enable Device Flow**
5. Copy the **Client ID** (it is public — safe to commit)
6. Open `src/lib/github-oauth.ts` and replace `'YOUR_OAUTH_APP_CLIENT_ID'` with your Client ID
7. Run `npm run build`

> The Client ID is **not** a secret. Device Flow requires no Client Secret.

### 2. Install the plugin

1. Clone or download this repository
2. Run `npm install && npm run build` to generate the `dist/` files
3. In Figma, go to **Plugins → Development → Import plugin from manifest**
4. Select the `manifest.json` file

### 3. Connect and configure

On first open, the plugin shows the onboarding screen:

**GitHub:**
1. Click **Sign in with GitHub**
2. A short code appears — click **Open GitHub ↗** (or go to [github.com/login/device](https://github.com/login/device) manually) and enter it
3. Approve access — the plugin connects automatically, no token copying required

**GitLab (or GitHub fallback):**
1. Click "Use a personal access token instead"
2. Create a token at [gitlab.com/-/user_settings/personal_access_tokens](https://gitlab.com/-/user_settings/personal_access_tokens) with the `api` scope
3. Paste it and click **Connect**

Once connected:
1. Select your repository from the dropdown
2. Pick or type a branch name (it will be created from your default branch on first push)
3. Set the tokens path (default: `tokens/`)
4. Click **Save settings** — the plugin switches to the Sync tab

Settings are saved locally in Figma. You won't need to sign in again.

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
- [ ] GitLab OAuth (Device Authorization Grant)
- [ ] Support for Bitbucket
- [ ] VS Code extension using the same token format

---

## License

MIT
