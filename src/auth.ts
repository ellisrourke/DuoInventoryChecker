// Access control. Order of precedence:
//   1. GitHub login (GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, ALLOWED_GITHUB_USERS)
//   2. Basic auth password (ADMIN_PASSWORD)
//   3. Nothing, but only on localhost; any other host fails closed with a 503.

export interface AuthDeps {
  adminPassword?: string;
  githubClientId?: string;
  githubClientSecret?: string;
  /** Comma-separated GitHub usernames allowed in. */
  allowedGithubUsers?: string;
  fetchFn?: typeof fetch;
}

const text = (body: string, status: number, extra: HeadersInit = {}) =>
  new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      ...extra,
    },
  });

async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function basicOk(req: Request, password: string): Promise<boolean> {
  const h = req.headers.get("authorization");
  if (!h || !/^basic\s+/i.test(h)) return false;
  let decoded: string;
  try {
    const bin = atob(h.replace(/^basic\s+/i, "").trim());
    decoded = new TextDecoder().decode(
      Uint8Array.from(bin, (c) => c.charCodeAt(0)),
    );
  } catch {
    return false;
  }
  const idx = decoded.indexOf(":");
  return idx >= 0 && await safeEqual(decoded.slice(idx + 1), password);
}

function isLocalhost(url: URL): boolean {
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
}

// The kv-oauth library opens Deno KV when imported, so load it on demand.
async function oauth(clientId: string, clientSecret: string) {
  const { createHelpers } = await import("@deno/kv-oauth");
  return {
    helpers: createHelpers({
      clientId,
      clientSecret,
      authorizationEndpointUri: "https://github.com/login/oauth/authorize",
      tokenUri: "https://github.com/login/oauth/access_token",
    }),
  };
}

const sessionKey = (id: string) => ["authed_sessions", id];

/**
 * Returns a Response when the request is handled or rejected, or `null` when
 * it may continue to the app.
 */
export async function guard(
  req: Request,
  kv: Deno.Kv,
  deps: AuthDeps = {},
): Promise<Response | null> {
  const url = new URL(req.url);
  const clientId = deps.githubClientId ?? Deno.env.get("GITHUB_CLIENT_ID");
  const secret = deps.githubClientSecret ??
    Deno.env.get("GITHUB_CLIENT_SECRET");
  const allowedRaw = deps.allowedGithubUsers ??
    Deno.env.get("ALLOWED_GITHUB_USERS") ?? "";
  const password = deps.adminPassword ?? Deno.env.get("ADMIN_PASSWORD");

  if (clientId && secret) {
    const allowed = allowedRaw.split(",").map((u) => u.trim().toLowerCase())
      .filter(Boolean);
    if (allowed.length === 0) {
      return text(
        "ALLOWED_GITHUB_USERS is not set. Set it to a comma-separated list of GitHub usernames.",
        503,
      );
    }

    if (url.pathname === "/signin" && req.method === "GET") {
      return (await oauth(clientId, secret)).helpers.signIn(req);
    }
    if (url.pathname === "/callback" && req.method === "GET") {
      const { helpers } = await oauth(clientId, secret);
      let result;
      try {
        result = await helpers.handleCallback(req);
      } catch {
        return text("Sign-in failed. Try again at /signin", 400);
      }
      const res = await (deps.fetchFn ?? fetch)("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${result.tokens.accessToken}`,
          "User-Agent": "stock-watcher",
          Accept: "application/vnd.github+json",
        },
      });
      const login: unknown = res.ok ? (await res.json())?.login : null;
      if (typeof login !== "string" || !allowed.includes(login.toLowerCase())) {
        await helpers.signOut(req);
        return text("This GitHub account is not allowed.", 403);
      }
      await kv.set(sessionKey(result.sessionId), login, {
        expireIn: 30 * 24 * 3600 * 1000,
      });
      return result.response;
    }
    if (url.pathname === "/signout") {
      const { helpers } = await oauth(clientId, secret);
      const id = await helpers.getSessionId(req);
      if (id) await kv.delete(sessionKey(id));
      return helpers.signOut(req);
    }

    // Only touch the library when a session cookie exists.
    if (/site-session=/.test(req.headers.get("cookie") ?? "")) {
      const id = await (await oauth(clientId, secret)).helpers.getSessionId(
        req,
      );
      if (id && (await kv.get(sessionKey(id))).value !== null) return null;
    }
    if (req.method === "GET" || req.method === "HEAD") {
      return new Response(null, {
        status: 303,
        headers: { Location: "/signin", "Cache-Control": "no-store" },
      });
    }
    return text("Authentication required", 401);
  }

  if (password) {
    return await basicOk(req, password) ? null : text(
      "Authentication required",
      401,
      { "WWW-Authenticate": 'Basic realm="Stock Watcher", charset="UTF-8"' },
    );
  }
  if (isLocalhost(url)) return null;
  return text(
    "No login is configured. Set GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET and ALLOWED_GITHUB_USERS (or ADMIN_PASSWORD) to enable this app.",
    503,
  );
}
