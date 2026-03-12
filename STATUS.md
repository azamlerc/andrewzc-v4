# Status

Updated by Codex on March 12, 2026.

## Summary

Added a new CLI image upload command that uses the same API/S3 workflow as the website.

## Changes Made Today

- Added a new command:
  - `node andrewzc.js image upload <list> <key> <file...>`
- Implemented the command in `commands/image-upload.js`.
- Added support for:
  - multiple input files
  - wildcard/glob patterns
  - direct upload through the API's presigned URL flow
- Added image processing with `sharp` to:
  - convert source images to JPEG
  - generate square `600x600` JPEG thumbnails
- Added a macOS fallback for HEIC/HEIF input using `sips` when the local `sharp` build lacks HEIC support.
- Updated auth handling to prefer:
  - `ANDREWZC_ADMIN_SESSION`
  - with username/password login kept as fallback
- Updated `README.md` to document:
  - the new image upload command
  - wildcard usage
  - required env vars
- Added the `sharp` dependency and refreshed the lockfile.

## Result

The CLI can now upload one or more local images, including HEIC files from Apple devices, using the same backend upload contract as the website.
