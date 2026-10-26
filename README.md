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

### Backfill locations from legacy coordinates

```bash
node andrewzc.js location backfill --dryrun  # preview the whole entities collection
node andrewzc.js location backfill           # apply across all lists/pages
node andrewzc.js location backfill bridges   # restrict to one list key
```

Only entities with an absent or null `location` and an existing `coords` field
are examined. Valid latitude/longitude strings become GeoJSON Points with
`[longitude, latitude]` coordinates. Decimal and DMS strings are supported.
Unknown/empty values are skipped; invalid values are reported without guessing.
Existing locations and legacy `coords` are preserved. Writes recheck the source
coordinates and missing location to protect concurrent edits. No enrichment or
external lookup runs. `--dryrun` (also `--test`) reports without writing.
Run again after applying: zero candidates means no convertible records remain.

### Entity location storage

`location` is the only supported location field: a GeoJSON Point with numeric
`[longitude, latitude]` coordinates, or null when unknown. Imports/upserts must
supply GeoJSON (a JSON object in JSON files, a JSON-encoded `location` cell in CSV).
Legacy `coords` input is rejected. Existing database `coords` values remain
untouched during the observation period; only `location backfill` reads them.
The existing `no-coords` page tag still disables location enrichment.

### Enrichment

The enrichment pipeline cascades name → link → location → city → reference.
Steps can be run individually or all at once.

```bash
node andrewzc.js enrich set-link <list>           # name → Wikipedia link
node andrewzc.js enrich set-location <list>         # link → coordinates
node andrewzc.js enrich set-city <list>           # location → nearest city
node andrewzc.js enrich set-reference <list>      # city → reference
node andrewzc.js enrich run <list>                # full cascade in sequence
```

`enrich set-location` options: `--test` (report only), `--dryrun` (preview). Missing/null locations are eligible; unsuccessful lookups leave location unset.

### Fill cities by searching outward

```bash
node andrewzc.js enrich set-city-from-cities --dryrun          # preview all cities
node andrewzc.js enrich set-city-from-cities                    # apply all cities
node andrewzc.js enrich set-city-from-cities brussels --dryrun # preview one city key
node andrewzc.js enrich set-city-from-cities brussels          # apply one city
```

For each source entity in `cities`, search eligible lists within **20 km**, sharing the
radius used by `enrich set-city`. Only entities whose `city` field is absent are
eligible; existing values, including null and empty strings, remain untouched.
Candidates need an indexed GeoJSON `location` (the existing location 2dsphere index).
The city’s display name is written to `city`; reference and other fields are unchanged.
Targets on `places`, `all-cities`, and `cities` are excluded, including in dry runs.
The `cities` list still supplies the source cities. Exclusions are checked again when writing.

With all cities, overlapping matches go to the nearest source city, with the city key
breaking exact-distance ties. With a city key, only that city’s radius participates:
nearby entities get that city even if another city is closer. An unknown city key or
invalid selected city fails without writes; an all-cities run reports and skips cities
without valid names/Point locations. Writes preserve concurrent changes to city/location.
`--dryrun` (also `--test`) performs the searches and reports assignments without writing.

### Keys

```bash
node andrewzc.js keys rekey <list> [--dryrun]     # regenerate keys from page tags
```

When a rekeyed entity would clash with an existing one, the two are merged
using per-field rules (longer wikiSummary wins, GeoJSON locations within 0.001° are
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

### Photos

```bash
node andrewzc.js photos export-album <AlbumName> <list> [--force] [--no-import] [import-album options...]
node andrewzc.js photos import-album <list> [album-json] [--radius <m>] [--originals <dir>] [--resume]
node andrewzc.js photos set-dates <list> [--key <key>] [--radius <m>] [--dryrun]
node andrewzc.js photos suggest <list> [--start <key>] [--radius <m>]
```

`export-album` is the one command to run for a new album. It wraps `osxphotos`
(requires it on PATH — `pipx install osxphotos`) to produce a JSON metadata
dump and a folder of full-resolution originals for a named Photos album, then
chains straight into `import-album` with the right paths already filled in —
the JSON file and originals folder are internal plumbing between the two
steps, not something to manage by hand. Pass `--no-import` to stop after the
export instead of continuing; any other flags (`--radius`, `--resume`, ...)
are forwarded through to `import-album`.

If `<list>.json` already exists from a previous run, it asks whether to
re-query Photos or keep the existing file and skip straight to exporting
originals (`--force` skips that prompt and always re-queries).

`import-album`'s `<album-json>` and `--originals` both default from `<list>`
to what `export-album` writes (`import-progress/<list>.json` and
`import-progress/<list>-originals/`), so `node andrewzc.js photos
import-album urinals` is enough on its own — pass them explicitly only to
use something else. It clusters the album's photos by location and calendar
day (a revisit on a different day is its own cluster, so it never re-uploads
an earlier visit's photos), and for each cluster prompts interactively for a
name (suggesting Photos place names, nearby entities already in the DB, and
the AI caption), then creates the entity — setting GeoJSON `location` from
the cluster's GPS, `dateVisited` from the photo date, and the country flag
icon from reverse-geocoded country — and uploads the photos. Progress is
saved after each cluster, so `--resume` picks up where you left off. Run it
directly (rather than via `export-album`) to resume a session or re-process
an export you already have.

`set-dates` and `suggest` are unrelated to a specific album: they query a
**local** MongoDB `photos.photos` collection (a separate, broader cache of
your whole photo library, populated outside this repo) to backfill
`dateVisited` or surface unlinked photos for existing entities on any list.
See `andrewzc-context/album-import-workflow.md` for the full walkthrough.

Example:

```bash
node andrewzc.js photos export-album Urinals urinals
```

## Architecture

```
andrewzc-v4/
  andrewzc.js       — entry point and command dispatcher
  database.js       — MongoDB operations (open/close per call; CLI pattern)
  utilities.js      — pure functions: simplify, computeKey, parseCoords, etc.
  commands/
    enrich-set-link.js
    enrich-set-location.js
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
import { getLocationFromUrl } from "../../andrewzc-api/wiki.js";
```

`utilities.js` in this folder is the canonical version of the shared pure functions.
`andrewzc-api/utils.js` should import from here for any functions they share
(simplify, computeKey, etc.) — or be kept in sync manually.

`database.js` in each project is intentionally different: the API uses a persistent
connection pool (correct for a server), while v4 opens/closes per call (correct for CLI).
# andrewzc-v4
