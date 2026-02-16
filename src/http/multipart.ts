import type { IncomingMessage } from 'node:http';

export interface ParsedMultipart {
  fields: Record<string, string>;
  file?: { filename: string; contentType: string; data: Buffer };
}

/** Parse a multipart/form-data request body into fields and an optional file. */
export function parseMultipart(req: IncomingMessage, boundary: string): Promise<ParsedMultipart> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const bodyStr = body.toString('latin1');
      const parts = bodyStr.split(`--${boundary}`).filter((p) => p && p !== '--\r\n' && p !== '--');

      const fields: Record<string, string> = {};
      let file: ParsedMultipart['file'];

      for (const part of parts) {
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;

        const headers = part.slice(0, headerEnd);
        const content = part.slice(headerEnd + 4, part.endsWith('\r\n') ? part.length - 2 : part.length);

        const filenameMatch = headers.match(/filename="([^"]+)"/);
        const nameMatch = headers.match(/name="([^"]+)"/);
        const ctMatch = headers.match(/Content-Type:\s*(.+)/i);

        if (filenameMatch) {
          const start = body.indexOf(Buffer.from(content, 'latin1'));
          file = {
            filename: filenameMatch[1]!,
            contentType: ctMatch?.[1]?.trim() ?? 'application/octet-stream',
            data: body.subarray(start, start + Buffer.byteLength(content, 'latin1')),
          };
        } else if (nameMatch) {
          fields[nameMatch[1]!] = content.trim();
        }
      }
      resolve({ fields, file });
    });
    req.on('error', reject);
  });
}
