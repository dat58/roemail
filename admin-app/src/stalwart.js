"use strict";

const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileP = promisify(execFile);

const STALWART_URL = (process.env.STALWART_URL || "http://127.0.0.1:8080").replace(/\/$/, "");
const STALWART_ADMIN_PASSWORD = process.env.STALWART_ADMIN_PASSWORD;
const DEFAULT_MAILBOX_PASSWORD = process.env.DEFAULT_MAILBOX_PASSWORD || "Hellototo123$";

if (!STALWART_ADMIN_PASSWORD) {
  throw new Error("Missing STALWART_ADMIN_PASSWORD environment variable");
}

function userError(message) {
  const e = new Error(message);
  e.statusCode = 400;
  return e;
}

function adminAuthHeader() {
  return "Basic " + Buffer.from(`admin:${STALWART_ADMIN_PASSWORD}`, "utf8").toString("base64");
}

// ---------------------------------------------------------------------------
// stalwart-cli wrapper (domain/mailbox CRUD — same tool stalwart.sh uses)
// ---------------------------------------------------------------------------

function cliEnv() {
  return {
    ...process.env,
    STALWART_URL: STALWART_URL,
    STALWART_USER: "admin",
    STALWART_PASSWORD: STALWART_ADMIN_PASSWORD,
  };
}

async function runCli(args) {
  try {
    const { stdout } = await execFileP("stalwart-cli", args, { env: cliEnv(), maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const msg = (err.stderr || err.stdout || err.message || "").toString().trim();
    const e = new Error(msg || `stalwart-cli ${args[0]} failed`);
    e.cliError = true;
    throw e;
  }
}

function parseNdjson(stdout) {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function listDomains() {
  const out = await runCli(["query", "Domain", "--fields", "id,name", "--json"]);
  return parseNdjson(out);
}

async function findDomainId(name) {
  const out = await runCli(["query", "Domain", "--where", `name=${name}`, "--fields", "id", "--json"]);
  const rows = parseNdjson(out);
  return rows[0] ? rows[0].id : null;
}

async function createDomain(name) {
  await runCli(["create", "Domain", "--field", `name=${name}`, "--field", `description=${name}`]);
}

async function deleteDomain(name) {
  const domainId = await findDomainId(name);
  if (!domainId) throw userError(`Domain '${name}' does not exist`);
  const dkimOut = await runCli(["query", "DkimSignature", "--where", `domainId=${domainId}`, "--fields", "id", "--json"]).catch(() => "");
  const dkimIds = parseNdjson(dkimOut || "").map((r) => r.id);
  if (dkimIds.length) await runCli(["delete", "DkimSignature", "--ids", dkimIds.join(",")]);
  await runCli(["delete", "Domain", "--ids", domainId]);
}

async function listMailboxes() {
  const out = await runCli(["query", "Account", "--fields", "id,name,emailAddress,domainId,usedDiskQuota", "--json"]);
  return parseNdjson(out);
}

async function createMailbox(email, quotaMb) {
  const atIdx = email.indexOf("@");
  if (atIdx <= 0) throw userError("Invalid email");
  const name = email.slice(0, atIdx);
  const domain = email.slice(atIdx + 1);

  const domainId = await findDomainId(domain);
  if (!domainId) throw userError(`Domain '${domain}' does not exist yet — create the domain first.`);

  const credentials = JSON.stringify({ "0": { "@type": "Password", secret: DEFAULT_MAILBOX_PASSWORD } });
  const args = [
    "create", "Account/User",
    "--field", `name=${name}`,
    "--field", `domainId=${domainId}`,
    "--field", `credentials=${credentials}`,
  ];
  if (quotaMb && Number(quotaMb) > 0) {
    const quotas = JSON.stringify({ maxDiskQuota: Math.round(Number(quotaMb) * 1024 * 1024) });
    args.push("--field", `quotas=${quotas}`);
  }
  await runCli(args);
  return { email, password: DEFAULT_MAILBOX_PASSWORD };
}

async function deleteMailbox(email) {
  const atIdx = email.indexOf("@");
  if (atIdx <= 0) throw userError("Invalid email");
  const name = email.slice(0, atIdx);
  const domain = email.slice(atIdx + 1);

  const domainId = await findDomainId(domain);
  if (!domainId) throw userError(`Domain '${domain}' does not exist`);
  const out = await runCli(["query", "Account", "--where", `name=${name}`, "--where", `domainId=${domainId}`, "--fields", "id", "--json"]);
  const rows = parseNdjson(out);
  if (!rows[0]) throw userError(`Mailbox not found: ${email}`);
  await runCli(["delete", "Account", "--ids", rows[0].id]);
}

// ---------------------------------------------------------------------------
// JMAP (admin cross-account access — reading/deleting mail needs no
// per-mailbox password: the admin session can act on any accountId).
// ---------------------------------------------------------------------------

let adminAccountIdCache = null;

async function jmapCall(body) {
  const resp = await fetch(`${STALWART_URL}/jmap/`, {
    method: "POST",
    headers: { Authorization: adminAuthHeader(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`JMAP HTTP ${resp.status}`);
  return resp.json();
}

async function getAdminAccountId() {
  if (adminAccountIdCache) return adminAccountIdCache;
  const resp = await fetch(`${STALWART_URL}/jmap/session`, { headers: { Authorization: adminAuthHeader() } });
  if (!resp.ok) throw new Error(`JMAP session HTTP ${resp.status}`);
  const session = await resp.json();
  adminAccountIdCache = session.primaryAccounts["urn:ietf:params:jmap:mail"];
  return adminAccountIdCache;
}

async function resolveAccountId(email) {
  const adminAccountId = await getAdminAccountId();
  const resp = await jmapCall({
    using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:principals"],
    methodCalls: [["Principal/query", { accountId: adminAccountId, filter: { email } }, "q"]],
  });
  const ids = resp.methodResponses[0][1]?.ids || [];
  if (!ids.length) throw userError(`Mailbox not found: ${email}`);
  return ids[0];
}

async function getInboxId(accountId) {
  const resp = await jmapCall({
    using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
    methodCalls: [["Mailbox/get", { accountId }, "0"]],
  });
  const list = resp.methodResponses[0][1].list || [];
  const inbox = list.find((m) => m.role === "inbox");
  if (!inbox) throw new Error("Inbox not found");
  return inbox.id;
}

function entDecode(s) {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&");
}
function htmlToText(html) {
  let s = html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  s = entDecode(s);
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
function bodyOf(email) {
  const bv = email.bodyValues || {};
  const tb = email.textBody || [];
  const hb = email.htmlBody || [];
  if (tb.length) return { text: tb.map((p) => (bv[p.partId] || {}).value || "").join("\n"), isHtml: false };
  if (hb.length) {
    const raw = hb.map((p) => (bv[p.partId] || {}).value || "").join("\n");
    return { text: htmlToText(raw), isHtml: true };
  }
  return { text: email.preview || "(no content)", isHtml: false };
}

async function listMessages(email, limit) {
  const accountId = await resolveAccountId(email);
  const inboxId = await getInboxId(accountId);
  const resp = await jmapCall({
    using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
    methodCalls: [
      ["Email/query", { accountId, filter: { inMailbox: inboxId }, sort: [{ property: "receivedAt", isAscending: false }], limit: limit || 50 }, "q"],
      ["Email/get", { accountId, "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
        properties: ["id", "subject", "from", "receivedAt", "preview", "keywords", "textBody", "htmlBody", "bodyValues"],
        fetchTextBodyValues: true, fetchHTMLBodyValues: true }, "g"],
    ],
  });
  const list = resp.methodResponses[1][1].list || [];
  return list.map((e) => {
    const body = bodyOf(e);
    return {
      id: e.id,
      subject: e.subject || "(no subject)",
      from: (e.from && e.from[0]) || null,
      receivedAt: e.receivedAt,
      preview: e.preview || "",
      seen: !!(e.keywords && e.keywords["$seen"]),
      bodyText: body.text,
      bodyIsHtml: body.isHtml,
    };
  });
}

async function markSeen(email, messageId) {
  const accountId = await resolveAccountId(email);
  const update = {};
  update[messageId] = { "keywords/$seen": true };
  await jmapCall({
    using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
    methodCalls: [["Email/set", { accountId, update }, "s"]],
  });
}

async function deleteMessage(email, messageId) {
  const accountId = await resolveAccountId(email);
  await jmapCall({
    using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
    methodCalls: [["Email/set", { accountId, destroy: [messageId] }, "d"]],
  });
}

module.exports = {
  DEFAULT_MAILBOX_PASSWORD,
  listDomains,
  createDomain,
  deleteDomain,
  listMailboxes,
  createMailbox,
  deleteMailbox,
  listMessages,
  markSeen,
  deleteMessage,
};
