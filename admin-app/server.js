"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const auth = require("./src/auth");
const sw = require("./src/stalwart");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const INDEX_HTML = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"));

function send(res, status, body, headers) {
  const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(payload);
}

function sendError(res, status, message) {
  send(res, status, { error: message });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function clientIp(req) {
  return (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const routes = [];
function route(method, pattern, handler) {
  routes.push({ method, pattern, handler });
}

route("GET", /^\/api\/me$/, async (req, res) => {
  send(res, 200, { authenticated: auth.isAuthenticated(req) });
});

route("POST", /^\/api\/login$/, async (req, res) => {
  const ip = clientIp(req);
  if (auth.isRateLimited(ip)) return sendError(res, 429, "Too many attempts, wait a few minutes and try again.");
  const body = await readJsonBody(req);
  if (!auth.checkPassword(body.password)) {
    auth.recordFailedAttempt(ip);
    return sendError(res, 401, "Wrong password.");
  }
  auth.clearAttempts(ip);
  auth.setSessionCookie(res, req);
  send(res, 200, { ok: true });
});

route("POST", /^\/api\/logout$/, async (req, res) => {
  auth.clearSessionCookie(res);
  send(res, 200, { ok: true });
});

function requireAuth(handler) {
  return async (req, res, params) => {
    if (!auth.isAuthenticated(req)) return sendError(res, 401, "Not logged in.");
    return handler(req, res, params);
  };
}

route("GET", /^\/api\/domains$/, requireAuth(async (req, res) => {
  send(res, 200, await sw.listDomains());
}));

route("POST", /^\/api\/domains$/, requireAuth(async (req, res) => {
  const body = await readJsonBody(req);
  const name = (body.name || "").trim();
  if (!name) return sendError(res, 400, "Missing domain name.");
  await sw.createDomain(name);
  send(res, 200, { ok: true });
}));

route("DELETE", /^\/api\/domains\/([^/]+)$/, requireAuth(async (req, res, [name]) => {
  await sw.deleteDomain(decodeURIComponent(name));
  send(res, 200, { ok: true });
}));

route("GET", /^\/api\/mailboxes$/, requireAuth(async (req, res) => {
  send(res, 200, await sw.listMailboxes());
}));

route("POST", /^\/api\/mailboxes$/, requireAuth(async (req, res) => {
  const body = await readJsonBody(req);
  const email = (body.email || "").trim().toLowerCase();
  if (!email || email.indexOf("@") <= 0) return sendError(res, 400, "Invalid email.");
  const result = await sw.createMailbox(email, body.quotaMb);
  send(res, 200, result);
}));

route("DELETE", /^\/api\/mailboxes\/([^/]+)$/, requireAuth(async (req, res, [email]) => {
  await sw.deleteMailbox(decodeURIComponent(email));
  send(res, 200, { ok: true });
}));

route("GET", /^\/api\/mailboxes\/([^/]+)\/messages$/, requireAuth(async (req, res, [email]) => {
  send(res, 200, await sw.listMessages(decodeURIComponent(email)));
}));

route("POST", /^\/api\/mailboxes\/([^/]+)\/messages\/([^/]+)\/seen$/, requireAuth(async (req, res, [email, id]) => {
  await sw.markSeen(decodeURIComponent(email), decodeURIComponent(id));
  send(res, 200, { ok: true });
}));

route("DELETE", /^\/api\/mailboxes\/([^/]+)\/messages\/([^/]+)$/, requireAuth(async (req, res, [email, id]) => {
  await sw.deleteMessage(decodeURIComponent(email), decodeURIComponent(id));
  send(res, 200, { ok: true });
}));

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;

  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(INDEX_HTML);
  }

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = pathname.match(r.pattern);
    if (!m) continue;
    try {
      await r.handler(req, res, m.slice(1));
    } catch (err) {
      const status = err.statusCode || (err.cliError ? 400 : 500);
      sendError(res, status, err.message || "Unknown error");
    }
    return;
  }

  sendError(res, 404, "Route not found");
});

server.listen(PORT, () => {
  console.log(`Stalwart admin console running on port ${PORT}`);
});
