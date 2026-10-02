// Cloudflare Email Worker: receives mail via Cloudflare Email Routing and
// pushes it straight into the matching Stalwart mailbox via JMAP
// (Principal/query + blob upload + Email/import), using the admin credential
// over the same HTTPS endpoint (cloudflared tunnel) the webui/JMAP already
// uses — no SMTP port needs to be opened.
//
// Limitation: Email/import inserts straight into the Inbox, bypassing
// Stalwart's spam scoring and Sieve scripts (unlike mail delivered through
// the normal SMTP port 25).

async function jmapCall(baseUrl, auth, body) {
  const resp = await fetch(`${baseUrl}/jmap/`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`JMAP request failed: ${resp.status} ${await resp.text()}`);
  }
  return resp.json();
}

export default {
  async email(message, env, ctx) {
    const baseUrl = env.STALWART_URL.replace(/\/$/, "");
    const auth = "Basic " + btoa(`admin:${env.STALWART_ADMIN_PASSWORD}`);
    const to = message.to.toLowerCase();

    // 0. The admin's own accountId, needed to scope the Principal (directory) query.
    const sessionResp = await fetch(`${baseUrl}/jmap/session`, {
      headers: { Authorization: auth },
    });
    if (!sessionResp.ok) {
      throw new Error(`Could not fetch JMAP session: ${sessionResp.status}`);
    }
    const session = await sessionResp.json();
    const adminAccountId = session.primaryAccounts["urn:ietf:params:jmap:mail"];

    // 1. Find the target mailbox's accountId by email address.
    const pq = await jmapCall(baseUrl, auth, {
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:principals"],
      methodCalls: [
        ["Principal/query", { accountId: adminAccountId, filter: { email: to } }, "q"],
      ],
    });
    const ids = pq.methodResponses[0][1]?.ids ?? [];
    if (ids.length === 0) {
      console.warn(`No mailbox for ${to}, rejecting.`);
      message.setReject(`550 5.1.1 No such mailbox: ${to}`);
      return;
    }
    const accountId = ids[0];

    // 2. Upload the raw RFC822 content as a blob in the target account.
    const raw = await new Response(message.raw).arrayBuffer();
    const uploadResp = await fetch(`${baseUrl}/jmap/upload/${accountId}/`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "message/rfc822" },
      body: raw,
    });
    if (!uploadResp.ok) {
      throw new Error(`Blob upload failed: ${uploadResp.status} ${await uploadResp.text()}`);
    }
    const { blobId } = await uploadResp.json();

    // 3. Find the target account's Inbox mailbox.
    const mq = await jmapCall(baseUrl, auth, {
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls: [
        ["Mailbox/query", { accountId, filter: { role: "inbox" } }, "m"],
      ],
    });
    const inboxIds = mq.methodResponses[0][1]?.ids ?? [];
    if (inboxIds.length === 0) {
      throw new Error(`Inbox not found for accountId=${accountId}`);
    }
    const inboxId = inboxIds[0];

    // 4. Import the email into the Inbox.
    const imp = await jmapCall(baseUrl, auth, {
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls: [
        [
          "Email/import",
          {
            accountId,
            emails: {
              "1": { blobId, mailboxIds: { [inboxId]: true }, keywords: {} },
            },
          },
          "i",
        ],
      ],
    });
    const result = imp.methodResponses[0][1];
    if (!result.created || !result.created["1"]) {
      throw new Error(`Email/import failed: ${JSON.stringify(result.notCreated)}`);
    }
    console.log(`Received mail for ${to} (accountId=${accountId})`);
  },
};
