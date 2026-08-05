import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { createDashboardServer } from "../dashboard-server.js";

function request(server, method, requestPath) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: address.address,
      port: address.port,
      path: requestPath,
      method,
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"], body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("dashboard server exposes read-only views and bounded APIs", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-dashboard-server-"));
  fs.mkdirSync(path.join(rootDir, "logs"));
  fs.writeFileSync(path.join(rootDir, "state.json"), JSON.stringify({ positions: {}, recentEvents: [] }));
  fs.writeFileSync(path.join(rootDir, "lessons.json"), JSON.stringify({ performance: [], lessons: [] }));
  fs.writeFileSync(path.join(rootDir, "decision-log.json"), JSON.stringify({ decisions: [] }));

  const server = createDashboardServer({ rootDir, liveReader: async () => ({ source: "test", positions: [] }) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
    server.close();
  });

  const page = await request(server, "GET", "/");
  assert.equal(page.status, 200);
  assert.match(page.type, /text\/html/);
  assert.match(page.body, /Meridian Control Room/);

  for (const endpoint of ["/api/overview", "/api/positions", "/api/flow", "/api/logs?limit=3"]) {
    const response = await request(server, "GET", endpoint);
    assert.equal(response.status, 200, endpoint);
    assert.match(response.type, /application\/json/);
    assert.doesNotThrow(() => JSON.parse(response.body));
  }

  const post = await request(server, "POST", "/api/overview");
  assert.equal(post.status, 405);
  const missing = await request(server, "GET", "/does-not-exist");
  assert.equal(missing.status, 404);
});
