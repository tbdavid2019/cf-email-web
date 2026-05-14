const MAIL_INDEX_KEY = "mail:index";
const MAX_MAIL_ITEMS = 200;
const MAX_RAW_PREVIEW_CHARS = 300000;
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

export default {
  async email(message, env, ctx) {
    const receivedAt = new Date().toISOString();
    const subject = decodeMimeHeader(message.headers.get("subject") || "(no subject)");
    const date = message.headers.get("date") || "";
    const messageId = message.headers.get("message-id") || crypto.randomUUID();

    let rawContent = "";
    try {
      rawContent = await readRawEmail(message.raw);
    } catch (error) {
      console.error("Failed to read raw email content", error);
      rawContent = "[raw email could not be read]";
    }

    try {
      await storeEmail(env, {
        id: crypto.randomUUID(),
        receivedAt,
        from: message.from,
        to: message.to,
        subject,
        date,
        messageId,
        rawSize: message.rawSize,
        ...extractBodies(rawContent),
      });
    } catch (error) {
      console.error("Failed to store email", error);
      throw error;
    }

    const targets = parseForwardTargets(env.FORWARD_TO);
    if (targets.length === 0) return;

    try {
      await Promise.all(targets.map((target) => message.forward(target)));
    } catch (error) {
      console.error("Forwarding failed", error);
      throw error;
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const isAuthenticated = await hasValidSession(request, env);

    if (request.method === "POST" && url.pathname === "/login") {
      return handleLogin(request, env, url);
    }

    if (request.method === "POST" && url.pathname === "/logout") {
      return redirect("/", {
        "Set-Cookie": expiredSessionCookie(url.protocol === "https:"),
      });
    }

    if (!isAuthenticated) {
      if (url.pathname === "/" || url.pathname === "/login") {
        return htmlResponse(renderLoginPage());
      }
      return redirect("/");
    }

    if (url.pathname === "/") {
      return redirect("/inbox");
    }

    if (url.pathname === "/inbox") {
      const emails = await listEmails(env);
      return htmlResponse(renderInboxPage(emails));
    }

    if (url.pathname.startsWith("/mail/")) {
      const id = url.pathname.slice("/mail/".length);
      const email = await getEmail(env, id);
      if (!email) return textResponse("Not found", 404);
      return htmlResponse(renderMailPage(email));
    }

    if (url.pathname.startsWith("/raw/")) {
      const id = url.pathname.slice("/raw/".length);
      const email = await getEmail(env, id);
      if (!email) return textResponse("Not found", 404);
      return textResponse(email.rawContent || "", 200, {
        "Content-Type": "text/plain; charset=utf-8",
      });
    }

    return textResponse("Not found", 404);
  },
};

async function handleLogin(request, env, url) {
  const formData = await request.formData();
  const password = String(formData.get("password") || "");

  if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) {
    return htmlResponse(
      renderLoginPage("Worker secrets ADMIN_PASSWORD / SESSION_SECRET are not configured."),
      500,
    );
  }

  const isValid = await secureEquals(password, env.ADMIN_PASSWORD);
  if (!isValid) {
    return htmlResponse(renderLoginPage("Password incorrect."), 401);
  }

  const sessionValue = await createSignedSession(env.SESSION_SECRET);
  return redirect("/inbox", {
    "Set-Cookie": buildSessionCookie(sessionValue, url.protocol === "https:"),
  });
}

async function storeEmail(env, email) {
  await putMailObject(env, email.id, email);

  const index = await getMailIndex(env);
  index.unshift({
    id: email.id,
    receivedAt: email.receivedAt,
    from: email.from,
    to: email.to,
    subject: email.subject,
    rawSize: email.rawSize,
  });

  const trimmed = index.slice(0, MAX_MAIL_ITEMS);
  await env.MAIL_STORE.put(MAIL_INDEX_KEY, JSON.stringify(trimmed));
}

async function listEmails(env) {
  return getMailIndex(env);
}

async function getEmail(env, id) {
  return getMailObject(env, id);
}

async function getMailIndex(env) {
  const raw = await env.MAIL_STORE.get(MAIL_INDEX_KEY);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function putMailObject(env, id, email) {
  const serialized = JSON.stringify(email);

  if (getStorageBackend(env) === "r2") {
    await env.MAIL_BUCKET.put(`mail/${id}.json`, serialized, {
      httpMetadata: {
        contentType: "application/json; charset=utf-8",
      },
    });
    return;
  }

  await env.MAIL_STORE.put(`mail:${id}`, serialized);
}

async function getMailObject(env, id) {
  if (getStorageBackend(env) === "r2") {
    const object = await env.MAIL_BUCKET.get(`mail/${id}.json`);
    if (!object) return null;
    return JSON.parse(await object.text());
  }

  const raw = await env.MAIL_STORE.get(`mail:${id}`);
  return raw ? JSON.parse(raw) : null;
}

function getStorageBackend(env) {
  const backend = String(env.STORAGE_BACKEND || "r2").trim().toLowerCase();
  return backend === "kv" ? "kv" : "r2";
}

async function hasValidSession(request, env) {
  if (!env.SESSION_SECRET) return false;

  const cookieHeader = request.headers.get("Cookie") || "";
  const session = readCookie(cookieHeader, "session");
  if (!session) return false;

  const [payload, signature] = session.split(".");
  if (!payload || !signature) return false;

  const expectedSignature = await sign(payload, env.SESSION_SECRET);
  if (!(await secureEquals(signature, expectedSignature))) return false;

  let decoded;
  try {
    decoded = JSON.parse(decodeBase64Url(payload));
  } catch {
    return false;
  }

  return Number(decoded.exp) > Math.floor(Date.now() / 1000);
}

async function createSignedSession(secret) {
  const payload = encodeBase64Url(
    JSON.stringify({
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    }),
  );
  const signature = await sign(payload, secret);
  return `${payload}.${signature}`;
}

async function sign(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return encodeBytesBase64Url(new Uint8Array(signature));
}

async function secureEquals(left, right) {
  const leftHash = await sha256(left);
  const rightHash = await sha256(right);
  return leftHash === rightHash;
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return encodeBytesBase64Url(new Uint8Array(digest));
}

function parseForwardTargets(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function readRawEmail(stream) {
  const reader = stream.getReader();
  const chunks = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return new TextDecoder().decode(merged);
}

function extractBodies(rawContent) {
  const normalized = String(rawContent || "").replace(/\r\n/g, "\n");
  const textPart = extractMimePart(normalized, "text/plain");
  const htmlPart = extractMimePart(normalized, "text/html");

  const fallbackBody = normalized.split("\n\n").slice(1).join("\n\n").trim();
  const rawPreview =
    normalized.length > MAX_RAW_PREVIEW_CHARS
      ? `${normalized.slice(0, MAX_RAW_PREVIEW_CHARS)}\n\n[truncated]`
      : normalized;

  return {
    textBody: textPart ? decodeMimeBody(textPart.body, textPart.encoding) : decodeQuotedPrintable(fallbackBody),
    htmlBody: htmlPart ? decodeMimeBody(htmlPart.body, htmlPart.encoding) : "",
    rawContent: rawPreview,
  };
}

function extractMimePart(content, mimeType) {
  const pattern = new RegExp(
    `Content-Type:\\s*${escapeRegExp(mimeType)}(?:;[^\\n]*)?[\\s\\S]*?\\n\\n([\\s\\S]*?)(?=\\n--|\\nContent-Type:|\\n$)`,
    "i",
  );
  const match = content.match(pattern);
  if (!match) return null;

  const fullMatch = match[0];
  const encodingMatch = fullMatch.match(/Content-Transfer-Encoding:\s*([^\n;]+)/i);

  return {
    body: match[1].trim(),
    encoding: encodingMatch ? encodingMatch[1].trim().toLowerCase() : "",
  };
}

function decodeMimeBody(body, encoding) {
  if (encoding === "base64") {
    return decodeBase64Mime(body);
  }

  if (encoding === "quoted-printable") {
    return decodeQuotedPrintable(body);
  }

  return String(body || "").trim();
}

function decodeQuotedPrintable(input) {
  return String(input || "")
    .replace(/=\n/g, "")
    .replace(/=([A-F0-9]{2})/gi, (_, hex) => {
      try {
        return String.fromCharCode(parseInt(hex, 16));
      } catch {
        return _;
      }
    });
}

function decodeBase64Mime(input) {
  try {
    const cleaned = String(input || "").replace(/\s+/g, "");
    const binary = atob(cleaned);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes).trim();
  } catch {
    return String(input || "").trim();
  }
}

function decodeMimeHeader(input) {
  const source = String(input || "");
  if (!source.includes("=?")) return source;

  return source.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, charset, encoding, value) => {
    try {
      const bytes =
        String(encoding).toUpperCase() === "B"
          ? decodeBase64ToBytes(value)
          : decodeQuotedPrintableHeaderToBytes(value);
      return new TextDecoder(normalizeCharset(charset), { fatal: false }).decode(bytes);
    } catch {
      return _;
    }
  });
}

function decodeBase64ToBytes(input) {
  const cleaned = String(input || "").replace(/\s+/g, "");
  const binary = atob(cleaned);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function decodeQuotedPrintableHeaderToBytes(input) {
  const normalized = String(input || "").replace(/_/g, " ");
  const bytes = [];

  for (let index = 0; index < normalized.length; index += 1) {
    if (normalized[index] === "=" && /[A-Fa-f0-9]{2}/.test(normalized.slice(index + 1, index + 3))) {
      bytes.push(parseInt(normalized.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(normalized.charCodeAt(index));
    }
  }

  return new Uint8Array(bytes);
}

function normalizeCharset(charset) {
  const normalized = String(charset || "utf-8").trim().toLowerCase();
  if (normalized === "utf8") return "utf-8";
  return normalized;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderLoginPage(errorMessage = "") {
  return renderLayout(
    "Mail Login",
    `
      <section class="card login-card">
        <h1>Mail Viewer</h1>
        <p class="muted">Incoming mail is stored by the Worker and protected by a password.</p>
        ${errorMessage ? `<p class="error">${escapeHtml(errorMessage)}</p>` : ""}
        <form method="post" action="/login" class="stack">
          <label for="password">Password</label>
          <input id="password" name="password" type="password" autocomplete="current-password" required />
          <button type="submit">Login</button>
        </form>
      </section>
    `,
  );
}

function renderInboxPage(emails) {
  const rows = emails.length
    ? emails
        .map(
          (email) => `
            <a class="mail-row" href="/mail/${encodeURIComponent(email.id)}">
              <div>
                <strong>${escapeHtml(email.subject || "(no subject)")}</strong>
                <div class="muted">${escapeHtml(email.from)} → ${escapeHtml(email.to)}</div>
              </div>
              <div class="mail-meta">
                <span>${escapeHtml(formatDate(email.receivedAt))}</span>
                <span>${escapeHtml(formatSize(email.rawSize))}</span>
              </div>
            </a>
          `,
        )
        .join("")
    : `<div class="empty">No email yet.</div>`;

  return renderLayout(
    "Inbox",
    `
      <header class="toolbar">
        <div>
          <h1>Inbox</h1>
          <p class="muted">Newest ${MAX_MAIL_ITEMS} emails indexed for web viewing.</p>
        </div>
        <form method="post" action="/logout">
          <button type="submit" class="secondary">Logout</button>
        </form>
      </header>
      <section class="card list-card">${rows}</section>
    `,
  );
}

function renderMailPage(email) {
  const renderedHtml = email.htmlBody
    ? `<iframe class="mail-frame" sandbox="" srcdoc="${escapeHtml(email.htmlBody)}"></iframe>`
    : `<div class="empty">No HTML body detected.</div>`;

  return renderLayout(
    email.subject || "Mail",
    `
      <header class="toolbar">
        <div>
          <a href="/inbox" class="back-link">← Back</a>
          <h1>${escapeHtml(email.subject || "(no subject)")}</h1>
          <p class="muted">${escapeHtml(email.from)} → ${escapeHtml(email.to)}</p>
        </div>
        <a class="button secondary" href="/raw/${encodeURIComponent(email.id)}">View Raw</a>
      </header>

      <section class="card detail-card">
        <dl class="meta-grid">
          <dt>Received</dt><dd>${escapeHtml(formatDate(email.receivedAt))}</dd>
          <dt>Date</dt><dd>${escapeHtml(email.date || "-")}</dd>
          <dt>Message-ID</dt><dd>${escapeHtml(email.messageId || "-")}</dd>
          <dt>Size</dt><dd>${escapeHtml(formatSize(email.rawSize))}</dd>
        </dl>
      </section>

      <section class="detail-grid">
        <article class="card">
          <h2>Text</h2>
          <pre>${escapeHtml(email.textBody || "(empty)")}</pre>
        </article>
        <article class="card">
          <h2>Rendered HTML</h2>
          ${renderedHtml}
        </article>
      </section>

      <section class="card">
        <h2>Stored Raw Preview</h2>
        <pre>${escapeHtml(email.rawContent || "(empty)")}</pre>
      </section>
    `,
  );
}

function renderLayout(title, content) {
  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${escapeHtml(title)}</title>
      <style>
        :root {
          --bg: #f3efe7;
          --panel: rgba(255,255,255,0.86);
          --ink: #1a1b1f;
          --muted: #59606d;
          --accent: #0f766e;
          --accent-2: #d97706;
          --line: rgba(26,27,31,0.1);
          --shadow: 0 20px 60px rgba(47, 52, 69, 0.15);
        }
        * { box-sizing: border-box; }
        body {
          margin: 0;
          font-family: "Iowan Old Style", "Palatino Linotype", serif;
          color: var(--ink);
          background:
            radial-gradient(circle at top left, rgba(217, 119, 6, 0.18), transparent 26rem),
            radial-gradient(circle at bottom right, rgba(15, 118, 110, 0.18), transparent 30rem),
            linear-gradient(135deg, #f8f3eb, #eef4f1);
        }
        a { color: inherit; text-decoration: none; }
        main {
          width: min(1100px, calc(100% - 32px));
          margin: 32px auto 64px;
        }
        h1, h2, strong { font-family: Georgia, serif; }
        .toolbar, .detail-grid {
          display: grid;
          gap: 16px;
        }
        .toolbar {
          grid-template-columns: 1fr auto;
          align-items: start;
          margin-bottom: 20px;
        }
        .detail-grid {
          grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
          margin-bottom: 20px;
        }
        .card {
          background: var(--panel);
          border: 1px solid var(--line);
          border-radius: 24px;
          box-shadow: var(--shadow);
          backdrop-filter: blur(16px);
          padding: 22px;
        }
        .login-card {
          max-width: 420px;
          margin: 10vh auto;
        }
        .stack { display: grid; gap: 12px; }
        .mail-row {
          display: grid;
          grid-template-columns: 1fr auto;
          gap: 16px;
          padding: 18px 6px;
          border-bottom: 1px solid var(--line);
        }
        .mail-row:last-child { border-bottom: 0; }
        .mail-row:hover { background: rgba(15, 118, 110, 0.05); border-radius: 16px; }
        .mail-meta {
          text-align: right;
          color: var(--muted);
          display: grid;
          gap: 4px;
          white-space: nowrap;
        }
        .muted { color: var(--muted); }
        .empty {
          padding: 18px 0;
          color: var(--muted);
        }
        .error {
          margin: 0;
          padding: 12px 14px;
          border-radius: 14px;
          background: rgba(190, 24, 93, 0.08);
          color: #9d174d;
        }
        label { font-size: 14px; color: var(--muted); }
        input {
          width: 100%;
          border: 1px solid var(--line);
          border-radius: 16px;
          padding: 14px 16px;
          font: inherit;
          background: rgba(255,255,255,0.8);
        }
        button, .button {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border: 0;
          border-radius: 999px;
          padding: 12px 18px;
          font: inherit;
          cursor: pointer;
          background: linear-gradient(135deg, var(--accent), #115e59);
          color: white;
        }
        .secondary {
          background: rgba(255,255,255,0.72);
          color: var(--ink);
          border: 1px solid var(--line);
        }
        .back-link {
          color: var(--accent);
          font-size: 14px;
        }
        .meta-grid {
          display: grid;
          grid-template-columns: max-content 1fr;
          gap: 10px 16px;
          margin: 0;
        }
        dt { color: var(--muted); }
        dd { margin: 0; word-break: break-word; }
        pre {
          margin: 0;
          white-space: pre-wrap;
          word-break: break-word;
          font-family: "SFMono-Regular", Consolas, monospace;
          font-size: 13px;
          line-height: 1.55;
        }
        .mail-frame {
          width: 100%;
          min-height: 420px;
          border: 1px solid var(--line);
          border-radius: 16px;
          background: white;
        }
        @media (max-width: 720px) {
          main { width: min(100% - 20px, 1100px); margin-top: 20px; }
          .toolbar, .mail-row { grid-template-columns: 1fr; }
          .mail-meta { text-align: left; }
        }
      </style>
    </head>
    <body>
      <main>${content}</main>
    </body>
  </html>`;
}

function formatDate(value) {
  try {
    return new Date(value).toLocaleString("zh-TW", { hour12: false });
  } catch {
    return value;
  }
}

function formatSize(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function htmlResponse(html, status = 200, extraHeaders = {}) {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      ...extraHeaders,
    },
  });
}

function textResponse(text, status = 200, extraHeaders = {}) {
  return new Response(text, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

function redirect(location, extraHeaders = {}) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

function buildSessionCookie(value, secure) {
  return `session=${value}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_SECONDS}; SameSite=Strict${secure ? "; Secure" : ""}`;
}

function expiredSessionCookie(secure) {
  return `session=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict${secure ? "; Secure" : ""}`;
}

function readCookie(cookieHeader, name) {
  const parts = cookieHeader.split(/;\s*/);
  for (const part of parts) {
    const [key, ...rest] = part.split("=");
    if (key === name) return rest.join("=");
  }
  return "";
}

function encodeBase64Url(input) {
  return btoa(input).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function encodeBytesBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeBase64Url(input) {
  const padded = input.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
  return atob(padded);
}
