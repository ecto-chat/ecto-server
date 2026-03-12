import http from 'node:http';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { eq, count } from 'drizzle-orm';
import { db } from '../db/index.js';
import { servers, serverConfig, members, customDomains } from '../db/schema/index.js';
import { config } from '../config/index.js';

// Cached font data (loaded once on first request)
let fontData: ArrayBuffer | null = null;
let fontLoadFailed = false;

async function loadFont(): Promise<ArrayBuffer> {
  if (fontData) return fontData;
  if (fontLoadFailed) throw new Error('Font load previously failed');

  try {
    // Fetch Inter font from Google Fonts (use old UA to get TTF format)
    const cssRes = await fetch(
      'https://fonts.googleapis.com/css2?family=Inter:wght@400;700',
      { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; U; Intel Mac OS X 10_6_8; de-at) AppleWebKit/533.21.1 (KHTML, like Gecko) Version/5.0.5 Safari/533.21.1' } },
    );
    const css = await cssRes.text();

    // Extract font URLs for 400 and 700 weights
    const urls = [...css.matchAll(/src:\s*url\(([^)]+)\)/g)].map((m) => m[1]!);
    if (urls.length === 0) throw new Error('No font URL found');

    const fontRes = await fetch(urls[0]!);
    fontData = await fontRes.arrayBuffer();
    return fontData;
  } catch (err) {
    fontLoadFailed = true;
    throw err;
  }
}

interface ServerInfo {
  name: string;
  description: string | null;
  iconUrl: string | null;
  bannerUrl: string | null;
  memberCount: number;
  badges: { label: string; color: string }[];
  tags: string[];
  inviteOnly: boolean;
}

export async function getServerInfo(serverAddress?: string): Promise<ServerInfo | null> {
  const d = db();

  let serverRow;
  if (serverAddress) {
    // Try matching by server address first (e.g., s-abc.ecto.chat)
    [serverRow] = await d.select().from(servers).where(eq(servers.address, serverAddress)).limit(1);

    // Fallback: check if it's a custom domain (e.g., catmaid.cafe)
    if (!serverRow) {
      const [domain] = await d
        .select({ serverId: customDomains.serverId })
        .from(customDomains)
        .where(eq(customDomains.domain, serverAddress))
        .limit(1);
      if (domain) {
        [serverRow] = await d.select().from(servers).where(eq(servers.id, domain.serverId)).limit(1);
      }
    }
  }

  // Single-tenant fallback: no address context → use the only server in the DB
  if (!serverRow && config.HOSTING_MODE === 'self-hosted') {
    [serverRow] = await d.select().from(servers).limit(1);
  }
  if (!serverRow) return null;

  const [memberResult] = await d.select({ count: count() }).from(members).where(eq(members.serverId, serverRow.id));

  // Fetch server config for badge info
  const [srvConfig] = await d.select().from(serverConfig).where(eq(serverConfig.serverId, serverRow.id)).limit(1);

  // Build feature badges
  const badges: { label: string; color: string }[] = [];

  if (config.HOSTING_MODE === 'self-hosted') {
    badges.push({ label: 'Self-Hosted', color: '#f59e0b' });
  } else {
    badges.push({ label: 'Central Hosted', color: '#6366f1' });
  }

  if (serverRow.centralConnected) {
    badges.push({ label: 'Central', color: '#3b82f6' });
  }

  if (srvConfig?.discoverable && srvConfig.discoveryApproved) {
    badges.push({ label: 'Discoverable', color: '#22c55e' });
  }

  if (srvConfig && srvConfig.maxSharedStorageBytes > 0) {
    badges.push({ label: 'File Sharing', color: '#8b5cf6' });
  }

  const inviteOnly = srvConfig?.requireInvite ?? false;
  if (inviteOnly) {
    badges.push({ label: 'Invite Only', color: '#ef4444' });
  }

  // Tags (only if discoverable)
  const tags: string[] = (srvConfig?.discoverable && srvConfig.tags) ? srvConfig.tags : [];

  return {
    name: serverRow.name,
    description: serverRow.description,
    iconUrl: serverRow.iconUrl,
    bannerUrl: serverRow.bannerUrl,
    memberCount: memberResult?.count ?? 0,
    badges,
    tags,
    inviteOnly,
  };
}

function buildElement(info: ServerInfo): Record<string, unknown> {
  const initial = info.name.charAt(0).toUpperCase();

  const children: Record<string, unknown>[] = [];

  // Banner background or gradient
  if (info.bannerUrl) {
    children.push({
      type: 'img',
      props: {
        src: info.bannerUrl,
        width: 1200,
        height: 630,
        style: {
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          objectFit: 'cover',
        },
      },
    });
    // Dark overlay
    children.push({
      type: 'div',
      props: {
        style: {
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          background: 'linear-gradient(180deg, rgba(17,17,20,0.6) 0%, rgba(17,17,20,0.92) 100%)',
        },
      },
    });
  }

  // Main content
  const iconElement = info.iconUrl
    ? {
        type: 'img',
        props: {
          src: info.iconUrl,
          width: 120,
          height: 120,
          style: {
            borderRadius: 24,
            objectFit: 'cover',
            border: '3px solid rgba(255,255,255,0.15)',
          },
        },
      }
    : {
        type: 'div',
        props: {
          style: {
            width: 120,
            height: 120,
            borderRadius: 24,
            background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 52,
            fontWeight: 700,
            color: '#ffffff',
            border: '3px solid rgba(255,255,255,0.15)',
          },
          children: initial,
        },
      };

  // Description (truncated to ~120 chars)
  const desc = info.description
    ? info.description.length > 120
      ? info.description.slice(0, 117) + '...'
      : info.description
    : null;

  const textChildren: Record<string, unknown>[] = [
    // Server name
    {
      type: 'div',
      props: {
        style: {
          fontSize: 48,
          fontWeight: 700,
          color: '#ffffff',
          lineHeight: 1.1,
          letterSpacing: '-0.02em',
          textShadow: '0 2px 8px rgba(0,0,0,0.3)',
        },
        children: info.name.length > 30 ? info.name.slice(0, 28) + '...' : info.name,
      },
    },
  ];

  if (desc) {
    textChildren.push({
      type: 'div',
      props: {
        style: {
          fontSize: 22,
          color: '#a1a1aa',
          lineHeight: 1.4,
          marginTop: 8,
          textShadow: '0 1px 4px rgba(0,0,0,0.3)',
        },
        children: desc,
      },
    });
  }

  // Member count row
  textChildren.push({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        marginTop: 16,
        fontSize: 20,
        color: '#71717a',
      },
      children: [
        {
          type: 'div',
          props: {
            style: {
              width: 10,
              height: 10,
              borderRadius: 5,
              backgroundColor: '#22c55e',
            },
          },
        },
        {
          type: 'span',
          props: {
            children: `${info.memberCount} member${info.memberCount !== 1 ? 's' : ''}`,
          },
        },
      ],
    },
  });

  // Feature badges row (below members)
  if (info.badges.length > 0) {
    textChildren.push({
      type: 'div',
      props: {
        style: {
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 8,
          marginTop: 10,
        },
        children: info.badges.map((badge) => ({
          type: 'div',
          props: {
            style: {
              display: 'flex',
              alignItems: 'center',
              padding: '6px 14px',
              borderRadius: 8,
              backgroundColor: badge.color,
              fontSize: 16,
              fontWeight: 700,
              color: '#ffffff',
            },
            children: badge.label,
          },
        })),
      },
    });
  }

  // Tags row (if discoverable with tags)
  if (info.tags.length > 0) {
    textChildren.push({
      type: 'div',
      props: {
        style: {
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 6,
          marginTop: 6,
        },
        children: info.tags.slice(0, 5).map((tag) => ({
          type: 'div',
          props: {
            style: {
              display: 'flex',
              alignItems: 'center',
              padding: '4px 10px',
              borderRadius: 6,
              backgroundColor: 'rgba(255,255,255,0.1)',
              border: '1px solid rgba(255,255,255,0.15)',
              fontSize: 14,
              fontWeight: 500,
              color: '#a1a1aa',
            },
            children: `#${tag}`,
          },
        })),
      },
    });
  }

  // Content area with icon + text
  children.push({
    type: 'div',
    props: {
      style: {
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 32,
        padding: '0 60px',
        flex: 1,
      },
      children: [
        iconElement,
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              flexDirection: 'column',
              flex: 1,
            },
            children: textChildren,
          },
        },
      ],
    },
  });

  // Bottom bar: CTA + branding
  children.push({
    type: 'div',
    props: {
      style: {
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 60px 40px',
      },
      children: [
        // Join button
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '12px 28px',
              borderRadius: 12,
              background: '#6366f1',
              color: '#ffffff',
              fontSize: 20,
              fontWeight: 700,
            },
            children: info.inviteOnly ? 'Invite Only' : 'Join Server',
          },
        },
        // Branding
        {
          type: 'div',
          props: {
            style: {
              fontSize: 20,
              fontWeight: 600,
              color: '#52525b',
              letterSpacing: '0.05em',
            },
            children: 'ecto.chat',
          },
        },
      ],
    },
  });

  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        width: '100%',
        height: '100%',
        background: info.bannerUrl
          ? '#111114'
          : 'linear-gradient(135deg, #111114 0%, #1e1b4b 50%, #111114 100%)',
        fontFamily: 'Inter, sans-serif',
        position: 'relative',
      },
      children,
    },
  };
}

export async function handleOgImage(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    const font = await loadFont();
    const serverAddr = req.headers['x-server-address'] as string | undefined;
    const info = await getServerInfo(serverAddr);

    if (!info) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Server not found');
      return;
    }

    const element = buildElement(info);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svg = await satori(element as any, {
      width: 1200,
      height: 630,
      fonts: [
        {
          name: 'Inter',
          data: font,
          weight: 400,
          style: 'normal' as const,
        },
      ],
    });

    const resvg = new Resvg(svg, {
      fitTo: { mode: 'width' as const, value: 1200 },
    });
    const png = resvg.render().asPng();

    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': png.length.toString(),
      'Cache-Control': 'public, max-age=3600, s-maxage=3600',
    });
    res.end(png);
  } catch (err) {
    console.error('OG image generation error:', err);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Image generation failed');
  }
}

/** Generate an HTML page with OG meta tags and a redirect to the client app. */
export function renderOgHtml(opts: {
  title: string;
  description: string;
  imageUrl: string;
  pageUrl: string;
  redirectUrl: string;
}): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(opts.title)}</title>
  <meta http-equiv="refresh" content="0;url=${esc(opts.redirectUrl)}" />

  <meta property="og:title" content="${esc(opts.title)}" />
  <meta property="og:description" content="${esc(opts.description)}" />
  <meta property="og:image" content="${esc(opts.imageUrl)}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="${esc(opts.pageUrl)}" />

  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(opts.title)}" />
  <meta name="twitter:description" content="${esc(opts.description)}" />
  <meta name="twitter:image" content="${esc(opts.imageUrl)}" />
</head>
<body>
  <p>Redirecting&hellip;</p>
</body>
</html>`;
}
