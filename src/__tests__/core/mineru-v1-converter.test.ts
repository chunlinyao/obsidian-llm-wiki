import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requestUrlMock = vi.hoisted(() => vi.fn());
const cacheStore = vi.hoisted(() => new Map<string, { markdown: string; metadata: { convertedAt: string; converter: string } }>());

vi.mock('obsidian', () => ({ requestUrl: requestUrlMock }));

vi.mock('../../core/pdf-cache', async () => {
  const actual = await vi.importActual<typeof import('../../core/pdf-cache')>('../../core/pdf-cache');
  return {
    ...actual,
    sha256Bytes: vi.fn(async () => 'source-hash'),
    hashCacheKey: vi.fn(async (key: string) => key),
    createPdfCache: () => ({
      get: async (key: string) => cacheStore.get(key) ?? null,
      set: async (key: string, value: { markdown: string; metadata: { convertedAt: string; converter: string } }) => {
        cacheStore.set(key, value);
      },
    }),
  };
});

import { convertPdfToMarkdown } from '../../core/pdf-converter';
import { convertPdfWithMineruV1 } from '../../core/mineru-v1-converter';

function context(overrides: Record<string, unknown> = {}) {
  const llmClient = { createMessage: vi.fn() };
  return {
    app: { vault: { adapter: { readBinary: vi.fn(async () => new Uint8Array([1, 2, 3])) } } } as never,
    settings: {
      provider: 'anthropic',
      apiKey: '',
      model: '',
      markdownConversionBackend: 'mineru' as const,
      mineruApiUrl: 'http://192.168.1.50:8000',
    },
    mineruApiToken: '',
    pdfFile: { path: 'paper.pdf', name: 'paper.pdf', extension: 'pdf' } as never,
    llmClient,
    resolveModelForTask: vi.fn(),
    subtle: {} as SubtleCrypto,
    ...overrides,
  };
}

function mockCompletedJob(fileId = 'file-1'): void {
  requestUrlMock
    .mockResolvedValueOnce({
      status: 201,
      json: {
        id: 'upload-1',
        status: 'pending',
        upload_url: '/v1/uploads/upload-1/content',
        upload_method: 'PUT',
        upload_headers: { 'Content-Type': 'application/pdf' },
      },
    })
    .mockResolvedValueOnce({ status: 200, json: {} })
    .mockResolvedValueOnce({
      status: 200,
      json: { id: 'upload-1', status: 'completed', file: { id: fileId } },
    })
    .mockResolvedValueOnce({
      status: 202,
      json: {
        job_id: 'job-1',
        status: 'completed',
        files: [{
          file_id: fileId,
          status: 'completed',
          output_files: { markdown: { file_id: 'markdown-1' } },
        }],
      },
    })
    .mockResolvedValueOnce({
      status: 200,
      arrayBuffer: new TextEncoder().encode('# Local MinerU\n').buffer,
    });
}

describe('MinerU self-hosted v1 converter', () => {
  beforeEach(() => {
    requestUrlMock.mockReset();
    cacheStore.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('dispatches to a configured self-hosted V1 service without requiring a token', async () => {
    mockCompletedJob();
    const ctx = context();
    const result = await convertPdfToMarkdown(ctx);

    expect(result.markdown).toBe('# Local MinerU\n');
    expect(ctx.llmClient.createMessage).not.toHaveBeenCalled();
    expect(requestUrlMock).toHaveBeenCalledTimes(5);
    expect(requestUrlMock.mock.calls[0]?.[0]).toMatchObject({
      url: 'http://192.168.1.50:8000/v1/uploads',
      method: 'POST',
    });
    expect(requestUrlMock.mock.calls[1]?.[0]).toMatchObject({
      url: 'http://192.168.1.50:8000/v1/uploads/upload-1/content',
      method: 'PUT',
    });
    expect(requestUrlMock.mock.calls[3]?.[0]).toMatchObject({
      url: 'http://192.168.1.50:8000/v1/parse/jobs',
      method: 'POST',
    });
    expect(requestUrlMock.mock.calls[4]?.[0]).toMatchObject({
      url: 'http://192.168.1.50:8000/v1/files/markdown-1/content',
      method: 'GET',
    });
    expect([...cacheStore.keys()]).toEqual([
      'source-hash:mineru-v1:http://192.168.1.50:8000:markdown:v1',
    ]);
  });

  it('uses the optional API token on API calls and same-origin byte uploads', async () => {
    mockCompletedJob();
    await convertPdfWithMineruV1(context({ mineruApiToken: ' secret ' }), 'http://192.168.1.50:8000');

    const createHeaders = requestUrlMock.mock.calls[0]?.[0]?.headers as Record<string, string>;
    const uploadHeaders = requestUrlMock.mock.calls[1]?.[0]?.headers as Record<string, string>;
    expect(createHeaders.Authorization).toBe('Bearer secret');
    expect(uploadHeaders.Authorization).toBe('Bearer secret');
  });

  it('never forwards the MinerU API token to a cross-origin upload URL', async () => {
    requestUrlMock
      .mockResolvedValueOnce({
        status: 201,
        json: {
          id: 'upload-1',
          status: 'pending',
          upload_url: 'https://storage.example/upload',
          upload_method: 'PUT',
          upload_headers: { 'x-storage-token': 'signed' },
        },
      })
      .mockResolvedValueOnce({ status: 200, json: {} })
      .mockResolvedValueOnce({
        status: 200,
        json: { id: 'upload-1', status: 'completed', file: { id: 'file-1' } },
      })
      .mockResolvedValueOnce({
        status: 202,
        json: {
          job_id: 'job-1',
          status: 'completed',
          files: [{
            file_id: 'file-1',
            status: 'completed',
            output_files: { markdown: { file_id: 'markdown-1' } },
          }],
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        arrayBuffer: new TextEncoder().encode('# Result').buffer,
      });

    await convertPdfWithMineruV1(context({ mineruApiToken: 'secret' }), 'http://192.168.1.50:8000');

    const upload = requestUrlMock.mock.calls[1]?.[0] as { headers: Record<string, string> };
    expect(upload.headers['x-storage-token']).toBe('signed');
    expect(upload.headers).not.toHaveProperty('Authorization');
  });

  it('supports server-side upload deduplication', async () => {
    requestUrlMock
      .mockResolvedValueOnce({
        status: 200,
        json: {
          id: 'upload-existing',
          status: 'completed',
          file: { id: 'file-existing' },
        },
      })
      .mockResolvedValueOnce({
        status: 202,
        json: {
          job_id: 'job-1',
          status: 'completed',
          files: [{
            file_id: 'file-existing',
            status: 'completed',
            output_files: { markdown: { file_id: 'markdown-1' } },
          }],
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        arrayBuffer: new TextEncoder().encode('# Deduplicated').buffer,
      });

    const result = await convertPdfWithMineruV1(context(), 'http://192.168.1.50:8000');

    expect(result.markdown).toBe('# Deduplicated');
    expect(requestUrlMock).toHaveBeenCalledTimes(3);
    expect(requestUrlMock.mock.calls[1]?.[0]).toMatchObject({
      url: 'http://192.168.1.50:8000/v1/parse/jobs',
    });
  });

  it('polls queued jobs until completion', async () => {
    vi.useFakeTimers();
    requestUrlMock
      .mockResolvedValueOnce({
        status: 201,
        json: {
          id: 'upload-1',
          status: 'pending',
          upload_url: '/v1/uploads/upload-1/content',
          upload_method: 'PUT',
          upload_headers: {},
        },
      })
      .mockResolvedValueOnce({ status: 200, json: {} })
      .mockResolvedValueOnce({
        status: 200,
        json: { id: 'upload-1', status: 'completed', file: { id: 'file-1' } },
      })
      .mockResolvedValueOnce({
        status: 202,
        json: { job_id: 'job-1', status: 'queued', files: [{ status: 'queued' }] },
      })
      .mockResolvedValueOnce({
        status: 200,
        json: {
          job_id: 'job-1',
          status: 'completed',
          files: [{
            file_id: 'file-1',
            status: 'completed',
            output_files: { markdown: { file_id: 'markdown-1' } },
          }],
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        arrayBuffer: new TextEncoder().encode('# Polled').buffer,
      });

    const conversion = convertPdfWithMineruV1(context(), 'http://192.168.1.50:8000');
    await vi.advanceTimersByTimeAsync(3000);
    const result = await conversion;

    expect(result.markdown).toBe('# Polled');
    expect(requestUrlMock.mock.calls[4]?.[0]).toMatchObject({
      url: 'http://192.168.1.50:8000/v1/parse/jobs/job-1',
      method: 'GET',
    });
  });

  it('surfaces parse failures from the V1 job response', async () => {
    requestUrlMock
      .mockResolvedValueOnce({
        status: 200,
        json: {
          id: 'upload-existing',
          status: 'completed',
          file: { id: 'file-existing' },
        },
      })
      .mockResolvedValueOnce({
        status: 202,
        json: {
          job_id: 'job-1',
          status: 'failed',
          files: [{
            file_id: 'file-existing',
            status: 'failed',
            error: { code: 'parse_failed', message: 'VLM failed' },
          }],
        },
      });

    await expect(convertPdfWithMineruV1(context(), 'http://192.168.1.50:8000'))
      .rejects.toThrow(/VLM failed/);
  });

  it('rejects a URL that already includes /v1 with a clear message', async () => {
    const readBinary = vi.fn();
    const ctx = context({ app: { vault: { adapter: { readBinary } } } });

    await expect(convertPdfWithMineruV1(ctx, 'http://192.168.1.50:8000/v1'))
      .rejects.toThrow(/before \/v1/);
    expect(readBinary).not.toHaveBeenCalled();
  });
});
