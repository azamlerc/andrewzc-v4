# andrewzc-v4

Unified CLI for the andrewzc.net MongoDB database.

## Setup

```bash
cp .env.example .env
# fill in MONGODB_URI and OPENAI_API_KEY
npm install
```

## Usage

```bash
node andrewzc.js <command> [args] [options]
node andrewzc.js --help
```

## Commands

### Enrichment

The enrichment pipeline cascades name → link → coords → city → reference.
Steps can be run individually or all at once.

```bash
node andrewzc.js enrich set-link <list>           # name → Wikipedia link
node andrewzc.js enrich set-coords <list>         # link → coordinates
node andrewzc.js enrich set-city <list>           # coords → nearest city
node andrewzc.js enrich set-reference <list>      # city → reference
node andrewzc.js enrich run <list>                # full cascade in sequence
```

`enrich set-coords` options: `--retry` (re-attempt "not-found"), `--test` (report only)

### Keys

```bash
node andrewzc.js keys rekey <list> [--dryrun]     # regenerate keys from page tags
```

When a rekeyed entity would clash with an existing one, the two are merged
using per-field rules (longer wikiSummary wins, coords within 0.001° are
compatible, URL-decoded links compared, props deep-merged).

### Props

```bash
node andrewzc.js props update <list> <file.json> [--dryrun]
node andrewzc.js props merge <main-list> <detail-list> [--dryrun]
node andrewzc.js props update-schema <list>
node andrewzc.js props delete <list> <prop>
node andrewzc.js props rename <list> <old-prop> <new-prop>
node andrewzc.js props make-numeric <list> <prop>
```

`props update` expects `{ "entity-key": { "prop": value, ... }, ... }`.
`props merge` merges a detail list (e.g. `metro-prices`) into props of a main list (e.g. `metros`).
`props rename` supports dot notation: `props rename countries left-to-right.prefix left-to-right.year`.
`props make-numeric` handles `$`, `K`, and `M` suffixes.

### Wikipedia / Embeddings

```bash
node andrewzc.js wiki load [list]                 # fetch summaries + embeddings
node andrewzc.js wiki clear <list> [--junk-only]  # clear all wiki data
node andrewzc.js wiki clear-embeddings <list>     # clear only embeddings (keep summaries)
node andrewzc.js wiki clear-embeddings --all      # clear embeddings across all lists
```

After `wiki clear-embeddings`, re-running `wiki load` regenerates embeddings
without hitting Wikipedia again.

### Stats

```bash
node andrewzc.js stats completion                 # visited/total % for all lists
node andrewzc.js stats links                      # Wikipedia link language breakdown
```

### Upsert

```bash
node andrewzc.js upsert <file.csv|json> [list]
```

Reads a CSV or JSON file and upserts each entity with full enrichment:
key computation, Wikipedia link search, coord fetching, city lookup, reference derivation.

For CSV, use dot-notation headers for nested fields (`props.year`, `icons.0`).
JSON can be an array or a key→entity object (legacy andrewzc.net format).
The `key` field must NOT be present — it is computed from `name`/`reference`/`country`.

### Images

```bash
node andrewzc.js image upload <list> <key> <file...>
```

Uploads one or more local images to the website image bucket using the API's
presigned upload flow. The CLI logs into the API, allocates the next numbered
filenames for the entity, converts each source image to JPEG, generates a
square `600x600` thumbnail, uploads both, then calls the API to append the
filenames to the entity's `images` array.

Examples:

```bash
node andrewzc.js image upload hamburgers bareburger image.heic
node andrewzc.js image upload hamburgers bareburger IMG_1234.HEIC IMG_1235.HEIC
node andrewzc.js image upload hamburgers bareburger IMG_*.HEIC
```

Globs are practical and supported. In normal shell usage, `zsh` expands
wildcards before invoking the script. The command also expands glob patterns
itself, so quoted patterns work too.

Add these variables to `.env`:

```bash
ANDREWZC_API_BASE=https://api.andrewzc.net
ANDREWZC_ADMIN_SESSION=...
```

`ANDREWZC_ADMIN_SESSION` should be the raw value of the `admin_session` cookie
from `api.andrewzc.net`. If you prefer, the command can still fall back to:

```bash
ANDREWZC_ADMIN_USERNAME=...
ANDREWZC_ADMIN_PASSWORD=...
```

## Architecture

```
andrewzc-v4/
  andrewzc.js       — entry point and command dispatcher
  database.js       — MongoDB operations (open/close per call; CLI pattern)
  utilities.js      — pure functions: simplify, computeKey, parseCoords, etc.
  commands/
    enrich-set-link.js
    enrich-set-coords.js
    enrich-set-city.js
    enrich-set-reference.js
    enrich-run.js
    keys-rekey.js
    props-update.js
    props-merge.js
    props-update-schema.js
    props-delete.js
    props-rename.js
    props-make-numeric.js
    wiki-load.js
    wiki-clear.js
    wiki-clear-embeddings.js
    stats-completion.js
    stats-links.js
    upsert.js
    image-upload.js
```

### Shared code with andrewzc-api

`wiki.js` lives in `andrewzc-api/` and is imported by v4 using a relative path:
```js
import { getCoordsFromUrl } from "../../andrewzc-api/wiki.js";
```

`utilities.js` in this folder is the canonical version of the shared pure functions.
`andrewzc-api/utils.js` should import from here for any functions they share
(simplify, computeKey, etc.) — or be kept in sync manually.

`database.js` in each project is intentionally different: the API uses a persistent
connection pool (correct for a server), while v4 opens/closes per call (correct for CLI).
# andrewzc-v4
