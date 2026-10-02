"use strict";

const crypto = require("crypto");

const APP_ADMIN_PASSWORD = process.env.APP_ADMIN_PASSWORD;
if (!APP_ADMIN_PASSWORD) {
  throw new Error("Missing APP_ADMIN_PASSWORD environment variable (the admin page's login password)");
}

// Stateless session: no server-side storage needed, but sessions become
// invalid on container restart unless SESSION_SECRET is pinned to a fixed value.
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const COOKIE_NAME = "stalwart_admin_session";

function sign(payload) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
}

function constantTimeEqual(a, b) {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function checkPassword(password) {
  return typeof password === "string" && constantTimeEqual(password, APP_ADMIN_PASSWORD);
}

function makeSessionCookieValue() {
  const payload = String(Date.now());
  return `${payload}.${sign(payload)}`;
}

function verifySessionCookieValue(value) {
  if (!value) return false;
  const idx = value.lastIndexOf(".");
  if (idx < 0) return false;
  const payload = value.slice(0, idx);
  const sig = value.slice(idx + 1);
  if (!constantTimeEqual(sig, sign(payload))) return false;
  const issuedAt = Number(payload);
  if (!Number.isFinite(issuedAt)) return false;
  return Date.now() - issuedAt < SESSION_MAX_AGE_MS;
}

function parseCookies(header) {
  const out = {};
  (header || "").split(";").forEach((part) => {
    const eq = part.indexOf("=");
    if (eq < 0) return;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function isAuthenticated(req) {
  const cookies = parseCookies(req.headers.cookie);
  return verifySessionCookieValue(cookies[COOKIE_NAME]);
}

function setSessionCookie(res, req) {
  const secure = (req.headers["x-forwarded-proto"] || "").includes("https") ? "; Secure" : "";
  const value = makeSessionCookieValue();
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}${secure}`
  );
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

// Light rate limiting for /api/login: at most 10 failed attempts / 15 min / IP.
const loginAttempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function isRateLimited(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.windowStart > WINDOW_MS) {
    loginAttempts.delete(ip);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

function recordFailedAttempt(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry || Date.now() - entry.windowStart > WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, windowStart: Date.now() });
  } else {
    entry.count += 1;
  }
}

function clearAttempts(ip) {
  loginAttempts.delete(ip);
}

module.exports = {
  checkPassword,
  isAuthenticated,
  setSessionCookie,
  clearSessionCookie,
  isRateLimited,
  recordFailedAttempt,
  clearAttempts,
};
