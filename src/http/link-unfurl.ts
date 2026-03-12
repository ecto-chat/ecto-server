import type http from 'node:http';

interface UnfurlResult {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
}

interface CacheEntry {
  data: UnfurlResult | null;
  expiresAt: number;
}

const MAX_CACHE_SIZE = 500;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_BODY_BYTES = 100 * 1024; // 100KB
const FETCH_TIMEOUT_MS = 5000;

const cache = new Map<string, CacheEntry>();

function evictExpiredAndOldest(): void {
  const now = Date.now();
  // First pass: remove expired entries
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  // If still over limit, remove oldest entries
  while (cache.size >= MAX_CACHE_SIZE) {
    const firstKey = cache.keys().next().value as string;
    cache.delete(firstKey);
  }
}

function parseOgTags(html: string, url: string): UnfurlResult | null {
  const getMeta = (property: string): string | undefined => {
    const regex = new RegExp(
      `<meta[^>]*(?:property|name)=["']${property}["'][^>]*content=["']([^"']*)["']`,
      'i',
    );
    const altRegex = new RegExp(
      `<meta[^>]*content=["']([^"']*)["'][^>]*(?:property|name)=["']${property}["']`,
      'i',
    );
    return regex.exec(html)?.[1] ?? altRegex.exec(html)?.[1];
  };

  const title = getMeta('og:title') ?? getMeta('twitter:title');
  const description = getMeta('og:description') ?? getMeta('twitter:description') ?? getMeta('description');
  const image = getMeta('og:image') ?? getMeta('twitter:image');
  const siteName = getMeta('og:site_name');

  if (!title && !description) return null;

  return {
    url,
    title: title ?? undefined,
    description: description ?? undefined,
    image: image ?? undefined,
    siteName: siteName ?? undefined,
  };
}

export async function handleLinkUnfurl(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  // Require authorization
  const auth = req.headers.authorization;
  if (!auth) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Authorization required' }));
    return;
  }

  const parsedUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const targetUrl = parsedUrl.searchParams.get('url');

  if (!targetUrl) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing url query parameter' }));
    return;
  }

  // Validate URL scheme
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid URL' }));
    return;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Only http and https URLs are supported' }));
    return;
  }

  // Check cache
  const now = Date.now();
  const cached = cache.get(targetUrl);
  if (cached && cached.expiresAt > now) {
    if (cached.data === null) {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=600',
    });
    res.end(JSON.stringify(cached.data));
    return;
  }

  try {
    const controller = new AbortController();
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'EctoBot/1.0',
        Accept: 'text/html',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });

    controller.abort(); // clean up if unused

    if (!response.ok) {
      evictExpiredAndOldest();
      cache.set(targetUrl, { data: null, expiresAt: now + CACHE_TTL_MS });
      res.writeHead(204);
      res.end();
      return;
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html')) {
      evictExpiredAndOldest();
      cache.set(targetUrl, { data: null, expiresAt: now + CACHE_TTL_MS });
      res.writeHead(204);
      res.end();
      return;
    }

    // Read body with size limit
    const reader = response.body?.getReader();
    if (!reader) {
      res.writeHead(204);
      res.end();
      return;
    }

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      chunks.push(value);
      if (totalBytes >= MAX_BODY_BYTES) {
        reader.cancel();
        break;
      }
    }

    const html = Buffer.concat(chunks).toString('utf-8');
    const data = parseOgTags(html, targetUrl);

    evictExpiredAndOldest();
    cache.set(targetUrl, { data, expiresAt: now + CACHE_TTL_MS });

    if (!data) {
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=600',
    });
    res.end(JSON.stringify(data));
  } catch {
    evictExpiredAndOldest();
    cache.set(targetUrl, { data: null, expiresAt: now + CACHE_TTL_MS });
    res.writeHead(204);
    res.end();
  }
}
