import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { glob } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";

const API_BASE = (process.env.ANDREWZC_API_BASE || "https://api.andrewzc.net").replace(/\/+$/, "");
const ADMIN_SESSION = process.env.ANDREWZC_ADMIN_SESSION || "";
const ADMIN_USERNAME = process.env.ANDREWZC_ADMIN_USERNAME || "";
const ADMIN_PASSWORD = process.env.ANDREWZC_ADMIN_PASSWORD || "";
const execFileAsync = promisify(execFile);

function usage() {
  console.error("Usage: andrewzc image upload <list> <key> <file...>");
  console.error("Examples:");
  console.error("  andrewzc image upload hamburgers bareburger image.heic");
  console.error("  andrewzc image upload hamburgers bareburger IMG_*.HEIC");
  process.exit(1);
}

async function expandInputPatterns(patterns) {
  const seen = new Set();
  const files = [];

  for (const pattern of patterns) {
    const hasGlob = /[*?[\]{}]/.test(pattern);
    if (hasGlob) {
      for await (const match of glob(pattern)) {
        const abs = resolve(match);
        if (seen.has(abs)) continue;
        seen.add(abs);
        files.push(abs);
      }
      continue;
    }

    const abs = resolve(pattern);
    if (seen.has(abs)) continue;
    seen.add(abs);
    files.push(abs);
  }

  return files;
}

async function ensureFilesExist(files) {
  const valid = [];
  for (const file of files) {
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) {
      console.error(`Missing file: ${file}`);
      continue;
    }
    valid.push(file);
  }
  return valid;
}

async function login() {
  if (ADMIN_SESSION) {
    return `admin_session=${ADMIN_SESSION}`;
  }

  if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
    console.error("Missing ANDREWZC_ADMIN_SESSION or admin username/password in .env");
    process.exit(1);
  }

  const res = await fetch(`${API_BASE}/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: ADMIN_USERNAME,
      password: ADMIN_PASSWORD,
      label: "andrewzc-v4 image upload",
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.message || data?.error || `Login failed (${res.status})`);
  }

  const cookie = res.headers.getSetCookie?.()[0] || res.headers.get("set-cookie");
  if (!cookie) {
    throw new Error("Login succeeded but no session cookie was returned");
  }

  return cookie.split(";")[0];
}

async function api(path, { method = "GET", cookie = "", body = null } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { "Cookie": cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.message || data?.error || `Request failed (${res.status})`);
  }

  return data;
}

async function putToS3(uploadUrl, buffer) {
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "image/jpeg" },
    body: buffer,
  });
  if (!res.ok) {
    throw new Error(`S3 PUT failed (${res.status})`);
  }
}

function isHeicPath(filePath) {
  return /\.(heic|heif)$/i.test(filePath);
}

async function convertHeicWithSips(filePath) {
  const outPath = `${tmpdir()}/${basename(filePath).replace(/\.(heic|heif)$/i, "")}-${Date.now()}.jpg`;
  await execFileAsync("sips", ["-s", "format", "jpeg", filePath, "--out", outPath]);
  return outPath;
}

async function withDecodableImage(filePath, fn) {
  let decodePath = filePath;
  let tempPath = null;

  if (process.platform === "darwin" && isHeicPath(filePath)) {
    tempPath = await convertHeicWithSips(filePath);
    decodePath = tempPath;
  }

  try {
    return await fn(decodePath);
  } finally {
    if (tempPath) {
      await import("node:fs/promises").then(fs => fs.unlink(tempPath).catch(() => {}));
    }
  }
}

async function makeUploadBuffers(filePath) {
  return withDecodableImage(filePath, async (decodePath) => {
    const image = sharp(decodePath).rotate();
    const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) {
      throw new Error(`Could not read image dimensions for ${basename(filePath)}`);
    }

    const originalBuffer = await image
      .clone()
      .jpeg({ quality: 90, mozjpeg: true })
      .toBuffer();

    const thumbBuffer = await image
      .clone()
      .resize(600, 600, { fit: "cover", position: "centre" })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer();

    return { originalBuffer, thumbBuffer };
  });
}

export async function run([list, key, ...patterns], _opts) {
  if (!list || !key || patterns.length === 0) usage();

  const expanded = await expandInputPatterns(patterns);
  const files = await ensureFilesExist(expanded);
  if (files.length === 0) {
    console.error("No matching files.");
    process.exit(1);
  }

  console.log(`Logging into ${API_BASE} …`);
  const cookie = await login();

  console.log(`Allocating ${files.length} upload target(s) for ${list}/${key} …`);
  const presigned = await api(`/entities/${encodeURIComponent(list)}/${encodeURIComponent(key)}/images/presign`, {
    method: "POST",
    cookie,
    body: { count: files.length },
  });

  const uploads = Array.isArray(presigned?.uploads) ? presigned.uploads : [];
  if (uploads.length !== files.length) {
    throw new Error("Presign response count did not match the selected files");
  }

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    const upload = uploads[i];
    console.log(`Preparing ${basename(file)} → ${upload.filename}`);
    const { originalBuffer, thumbBuffer } = await makeUploadBuffers(file);

    console.log(`Uploading ${upload.filename} …`);
    await putToS3(upload.originalUploadUrl, originalBuffer);
    await putToS3(upload.thumbUploadUrl, thumbBuffer);
  }

  await api(`/entities/${encodeURIComponent(list)}/${encodeURIComponent(key)}/images/complete`, {
    method: "POST",
    cookie,
    body: { filenames: uploads.map(upload => upload.filename) },
  });

  console.log(`Uploaded ${uploads.length} image(s) to ${list}/${key}.`);
  uploads.forEach(upload => console.log(`  ${upload.filename}`));
}
