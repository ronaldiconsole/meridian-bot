import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { repoPath, REPO_ROOT } from "./repo-root.js";
import { readDashboardData, readLogs } from "./dashboard-data.js";

// The bot normally loads .env through config.js, but the dashboard is a
// standalone process. Read only the four non-secret dashboard switches (plus
// DRY_RUN) so `npm run dashboard` behaves consistently without exposing .env.
function loadSafeDashboardEnv() {
  if (!fs.existsSync(repoPath(".env"))) return;
  let contents;
  try { contents = fs.readFileSync(repoPath(".env"), "utf8"); } catch { return; }
  for (const name of ["DASHBOARD_HOST", "DASHBOARD_PORT", "DASHBOARD_REFRESH_MS", "DRY_RUN"]) {
    if (process.env[name] != null) continue;
    const match = contents.match(new RegExp(`^\\s*${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^#\\r\\n]*))`, "m"));
    const value = match && (match[1] ?? match[2] ?? match[3])?.trim();
    if (value) process.env[name] = value;
  }
}

loadSafeDashboardEnv();

const DEFAULT_HOST = process.env.DASHBOARD_HOST || "127.0.0.1";
const DEFAULT_PORT = Number(process.env.DASHBOARD_PORT || 8787);
const MAX_LOG_LIMIT = 200;

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json; charset=utf-8",
  }[ext] || "application/octet-stream";
}

function staticFilePath(staticDir, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  if (!relative || relative.includes("\0")) return null;
  const root = path.resolve(staticDir);
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) return null;
  return target;
}

async function apiResponse(url, { rootDir, liveReader }) {
  if (url.pathname === "/api/overview") {
    const data = await readDashboardData({ rootDir, liveReader });
    return { status: 200, payload: data };
  }
  if (url.pathname === "/api/positions") {
    const data = await readDashboardData({ rootDir, liveReader });
    return { status: 200, payload: {
      generated_at: data.generated_at,
      source: data.summary.data_status,
      summary: data.summary,
      positions: data.positions,
      pnl_history: data.pnl_history,
      data_status: data.summary.data_status,
      error: data.summary.data_status === "unavailable" ? "Live and local position data are unavailable" : null,
    } };
  }
  if (url.pathname === "/api/flow") {
    const data = await readDashboardData({ rootDir, liveReader });
    return { status: 200, payload: { generated_at: data.generated_at, updated_at: data.generated_at, runtime: data.runtime, ...data.flow } };
  }
  if (url.pathname === "/api/logs") {
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 100) || 100, 1), MAX_LOG_LIMIT);
    const payload = readLogs({
      rootDir,
      source: url.searchParams.get("source") || "all",
      level: url.searchParams.get("level") || "all",
      q: url.searchParams.get("q") || "",
      limit,
    });
    return { status: 200, payload };
  }
  return null;
}

export function createDashboardServer({ rootDir = REPO_ROOT, staticDir = repoPath("dashboard"), liveReader } = {}) {
  return http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    } catch {
      json(res, 400, { error: "Invalid request URL" });
      return;
    }

    if (req.method !== "GET") {
      res.setHeader("allow", "GET");
      json(res, 405, { error: "Dashboard is read-only; only GET is supported" });
      return;
    }

    try {
      if (url.pathname.startsWith("/api/")) {
        const response = await apiResponse(url, { rootDir, liveReader });
        if (!response) {
          json(res, 404, { error: "API route not found" });
          return;
        }
        json(res, response.status, response.payload);
        return;
      }

      const filePath = staticFilePath(staticDir, url.pathname);
      if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        json(res, 404, { error: "Not found" });
        return;
      }
      const body = fs.readFileSync(filePath);
      res.writeHead(200, {
        "content-type": contentType(filePath),
        "cache-control": "no-cache",
        "content-length": body.byteLength,
      });
      res.end(body);
    } catch (error) {
      json(res, 500, { error: "Dashboard data is temporarily unavailable" });
      if (process.env.DASHBOARD_DEBUG === "true") console.error(error);
    }
  });
}

export function startDashboardServer({ host = DEFAULT_HOST, port = DEFAULT_PORT, rootDir = REPO_ROOT, staticDir = repoPath("dashboard"), liveReader } = {}) {
  const server = createDashboardServer({ rootDir, staticDir, liveReader });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  startDashboardServer()
    .then((server) => {
      const address = server.address();
      console.log(`Meridian dashboard listening at http://${address.address}:${address.port}`);
      const close = () => server.close(() => process.exit(0));
      process.once("SIGINT", close);
      process.once("SIGTERM", close);
    })
    .catch((error) => {
      console.error(`Unable to start dashboard: ${error.message}`);
      process.exitCode = 1;
    });
}
