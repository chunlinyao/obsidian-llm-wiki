import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

const requestUrlMock = vi.hoisted(() => vi.fn());
const cacheStore = vi.hoisted(() => new Map<string, { markdown: string; metadata: { convertedAt: string; converter: string } }>());

vi.mock('obsidian', () => ({ requestUrl: requestUrlMock }));

vi.mock('../../core/pdf-cache', async () => {
  const actual = await vi.importActual<typeof import('../../core/pdf-cache')>('../../core/pdf-cache');
  return {
    ...actual,
    sha256Bytes: vi.fn(async () => 'http-source-hash'),
    hashCacheKey: vi.fn(async (key: string) => key),
    createPdfCache: () => ({
      get: async (key: string) => cacheStore.get(key) ?? null,
      set: async (key: string, value: { markdown: string; metadata: { convertedAt: string; converter: string } }) => {
        cacheStore.set(key, value);
      },
    }),
  };
});

import { convertPdfWithMineruV1 } from '../../core/mineru-v1-converter';

let baseUrl = '';
let server: ReturnType<typeof createServer>;
let receivedPdf = new Uint8Array();
let parseBody: unknown;
let authLog: Array<{ path: string; authorization?: string }> = [];

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const encoded = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': String(encoded.length),
  });
  res.end(encoded);
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const path = req.url ?? '/';
    authLog.push({
      path,
      ...(typeof req.headers.authorization === 'string' ? { authorization: req.headers.authorization } : {}),
    });

    if (req.method === 'POST' && path === '/v1/uploads') {
      const body = JSON.parse((await readBody(req)).toString('utf8')) as Record<string, unknown>;
      expect(body).toMatchObject({
        filename: 'paper.pdf',
        bytes: 5,
        mime_type: 'application/pdf',
        purpose: 'parse',
      });
      json(res, 201, {
        id: 'upload-http-1',
        status: 'pending',
        upload_url: '/v1/uploads/upload-http-1/content',
        upload_method: 'PUT',
        upload_headers: { 'Content-Type': 'application/pdf' },
      });
      return;
    }

    if (req.method === 'PUT' && path === '/v1/uploads/upload-http-1/content') {
      receivedPdf = new Uint8Array(await readBody(req));
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.method === 'POST' && path === '/v1/uploads/upload-http-1/complete') {
      json(res, 200, {
        id: 'upload-http-1',
        status: 'completed',
        file: { id: 'file-http-1' },
      });
      return;
    }

    if (req.method === 'POST' && path === '/v1/parse/jobs') {
      parseBody = JSON.parse((await readBody(req)).toString('utf8'));
      json(res, 202, {
        job_id: 'job-http-1',
        status: 'queued',
        files: [{ file_id: 'file-http-1', status: 'queued' }],
      });
      return;
    }

    if (req.method === 'GET' && path === '/v1/parse/jobs/job-http-1') {
      json(res, 200, {
        job_id: 'job-http-1',
        status: 'completed',
        files: [{
          file_id: 'file-http-1',
          name: 'paper.pdf',
          status: 'completed',
          output_files: {
            markdown: { file_id: 'markdown-http-1', bytes: 31 },
          },
        }],
      });
      return;
    }

    if (req.method === 'GET' && path === '/v1/files/markdown-http-1/content') {
      const body = Buffer.from('# MinerU HTTP integration\n');
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Length': String(body.length),
      });
      res.end(body);
      return;
    }

    json(res, 404, { error: { code: 'not_found', message: path } });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
});

beforeEach(() => {
  cacheStore.clear();
  receivedPdf = new Uint8Array();
  parseBody = undefined;
  authLog = [];
  requestUrlMock.mockReset();
  requestUrlMock.mockImplementation(async (options: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string | ArrayBuffer;
  }) => {
    const response = await fetch(options.url, {
      method: options.method ?? 'GET',
      headers: options.headers,
      ...(options.body !== undefined ? { body: options.body } : {}),
    });
    const arrayBuffer = await response.arrayBuffer();
    let parsedJson: unknown = undefined;
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json') && arrayBuffer.byteLength > 0) {
      parsedJson = JSON.parse(new TextDecoder().decode(arrayBuffer));
    }
    return {
      status: response.status,
      json: parsedJson,
      arrayBuffer,
    };
  });
});

describe('MinerU self-hosted v1 real HTTP integration', () => {
  it('completes the official V1 upload → job → output cycle over TCP', async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x0a]);
    const phases: string[] = [];
    const ctx = {
      app: { vault: { adapter: { readBinary: vi.fn(async () => pdfBytes) } } } as never,
      settings: {
        provider: 'anthropic',
        apiKey: '',
        model: '',
        markdownConversionBackend: 'mineru' as const,
        mineruApiUrl: baseUrl,
      },
      mineruApiToken: 'integration-secret',
      pdfFile: { path: 'paper.pdf', name: 'paper.pdf', extension: 'pdf' } as never,
      llmClient: { createMessage: vi.fn() },
      resolveModelForTask: vi.fn(),
      subtle: {} as SubtleCrypto,
      onMineruPhase: (phase: string) => phases.push(phase),
    };

    vi.useFakeTimers();
    const conversion = convertPdfWithMineruV1(ctx, baseUrl);
    await vi.advanceTimersByTimeAsync(3000);
    const result = await conversion;
    vi.useRealTimers();

    expect(result.markdown).toBe('# MinerU HTTP integration\n');
    expect(receivedPdf).toEqual(pdfBytes);
    expect(parseBody).toEqual({
      files: [{ source: { type: 'file_id', file_id: 'file-http-1' } }],
      ocr_mode: 'auto',
      output_formats: ['markdown'],
    });
    expect(phases).toEqual(['uploading', 'waiting', 'downloading']);
    expect(authLog).toEqual([
      { path: '/v1/uploads', authorization: 'Bearer integration-secret' },
      { path: '/v1/uploads/upload-http-1/content', authorization: 'Bearer integration-secret' },
      { path: '/v1/uploads/upload-http-1/complete', authorization: 'Bearer integration-secret' },
      { path: '/v1/parse/jobs', authorization: 'Bearer integration-secret' },
      { path: '/v1/parse/jobs/job-http-1', authorization: 'Bearer integration-secret' },
      { path: '/v1/files/markdown-http-1/content', authorization: 'Bearer integration-secret' },
    ]);
  }, 15_000);
});
