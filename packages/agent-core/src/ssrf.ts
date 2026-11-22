// SSRF guard for customer-supplied URLs (remote MCP servers). https only, no
// credentials in the URL, no IP literals in private, loopback, link-local or
// metadata ranges, no internal hostnames, and no other tenant's workers.dev.

const BLOCKED_HOST_SUFFIXES = [".internal", ".local", ".localhost", ".lan", ".home", ".corp"];

function ipv4Blocked(host: string): boolean | null {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true;
  return false;
}

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

export function checkRemoteUrl(raw: string, opts: { ownWorkersDevPrefix?: string } = {}): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "only https URLs are allowed" };
  if (url.username || url.password) return { ok: false, reason: "credentials in the URL are not allowed" };
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || !host.includes(".") && !host.includes(":")) {
    return { ok: false, reason: "internal hostnames are not allowed" };
  }
  if (BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) return { ok: false, reason: "internal hostnames are not allowed" };
  const v4 = ipv4Blocked(host);
  if (v4) return { ok: false, reason: "private and reserved addresses are not allowed" };
  if (host.includes(":")) {
    // IPv6 literal: refuse loopback, unique-local, link-local and mapped v4.
    if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80") || host.startsWith("::ffff:")) {
      return { ok: false, reason: "private and reserved addresses are not allowed" };
    }
  }
  if (host.endsWith(".workers.dev") && opts.ownWorkersDevPrefix && host.startsWith(opts.ownWorkersDevPrefix)) {
    return { ok: false, reason: "agentdesk's own Workers cannot be registered as MCP servers" };
  }
  return { ok: true, url };
}
