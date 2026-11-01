/**
 * The login page. Served for every denial — unknown cookie, bad password,
 * expired session — and it never names the artifact or says whether the key
 * exists.
 */

const PAGE = (error: string, next: string) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Protected</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif; display:grid;
         place-items:center; min-height:100svh; margin:0; }
  form { display:grid; gap:12px; width:min(320px,88vw); }
  h1 { font-size:17px; font-weight:600; margin:0 0 4px; }
  input,button { font:inherit; padding:9px 11px; border-radius:8px;
                 border:1px solid color-mix(in oklab, currentColor 28%, transparent); }
  button { cursor:pointer; border-color:transparent; background:currentColor; }
  button span { filter:invert(1); }
  p.err { margin:0; color:#c0392b; font-size:13px; }
</style>
</head><body>
<form method="POST" action="/_auth">
  <h1>This artifact is password protected</h1>
  ${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
  <input type="hidden" name="next" value="${escapeHtml(next)}">
  <input type="password" name="password" placeholder="Password" autocomplete="current-password"
         autofocus required>
  <button type="submit"><span>Unlock</span></button>
</form>
</body></html>`;

export function loginPage(status: number, next: string, error = ""): Response {
  return new Response(PAGE(error, next), {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      // The login page is ours, so it gets a real CSP rather than the sandbox
      // one the artifacts get.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
      "referrer-policy": "no-referrer",
    },
  });
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
