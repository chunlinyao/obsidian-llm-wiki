import { requestUrl } from 'obsidian';
import {
  MINERU_POLL_INTERVAL_MS,
  MINERU_TIMEOUT_MS,
  PDF_CACHE_MAX_SINGLE_ENTRY_BYTES,
} from '../constants';
import {
  createPdfCache,
  hashCacheKey,
  sha256Bytes,
} from './pdf-cache';
import type { ConversionResult, PdfConversionContext } from './pdf-converter';
import { MineruPdfError } from './mineru-converter';

type JsonRecord = Record<string, unknown>;

const TERMINAL_JOB_STATES = new Set(['completed', 'partial', 'failed', 'canceled']);
const ACTIVE_JOB_STATES = new Set(['queued', 'running']);

function abortError(): DOMException {
  return new DOMException('MinerU conversion was cancelled.', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function withDeadline<T>(promise: Promise<T>, deadline: number, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timeout = 0;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      settle();
    };
    const onAbort = () => finish(() => reject(abortError()));
    timeout = window.setTimeout(
      () => finish(() => reject(new MineruPdfError('MinerU conversion timed out after 30 minutes.'))),
      Math.max(0, deadline - Date.now()),
    );
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error instanceof Error ? error : new MineruPdfError('MinerU request failed.'))),
    );
  });
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function requiredString(value: unknown, label: string): string {
  const result = stringValue(value);
  if (!result) throw new MineruPdfError(`MinerU v1 returned an invalid ${label}.`);
  return result;
}

function authHeaders(token: string | undefined): Record<string, string> {
  const trimmed = token?.trim();
  return trimmed ? { Authorization: `Bearer ${trimmed}` } : {};
}

function normalizeApiRoot(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new MineruPdfError('MinerU self-hosted API URL is invalid.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new MineruPdfError('MinerU self-hosted API URL must be an HTTP(S) service root without credentials, query, or fragment.');
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith('/v1')) {
    throw new MineruPdfError('MinerU self-hosted API URL must be the service root before /v1.');
  }
  url.pathname = path || '/';
  return url.href.replace(/\/+$/, '');
}

function resolveReturnedUrl(baseUrl: string, value: string): URL {
  let url: URL;
  try {
    url = new URL(value, `${baseUrl}/`);
  } catch {
    throw new MineruPdfError('MinerU v1 returned an invalid upload URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new MineruPdfError('MinerU v1 returned an unsafe upload URL.');
  }
  return url;
}

function stringHeaderMap(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  const record = asRecord(value);
  if (!record) throw new MineruPdfError('MinerU v1 upload_headers must be an object.');
  const result: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(record)) {
    if (typeof headerValue !== 'string' || /[\r\n]/.test(key + headerValue)) {
      throw new MineruPdfError('MinerU v1 returned invalid upload headers.');
    }
    result[key] = headerValue;
  }
  return result;
}

function mimeTypeForName(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const mimeTypes: Record<string, string> = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    jp2: 'image/jp2',
    webp: 'image/webp',
    gif: 'image/gif',
    bmp: 'image/bmp',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  return mimeTypes[ext] ?? 'application/octet-stream';
}

function errorMessageFromJson(json: unknown): string | undefined {
  const record = asRecord(json);
  const error = asRecord(record?.error);
  return stringValue(error?.message)
    ?? stringValue(record?.message)
    ?? stringValue(record?.msg);
}

async function requestJson(
  baseUrl: string,
  path: string,
  token: string | undefined,
  request: { method: string; body?: JsonRecord },
  deadline: number,
  signal?: AbortSignal,
): Promise<JsonRecord> {
  throwIfAborted(signal);
  const response = await withDeadline(requestUrl({
    url: `${baseUrl}${path}`,
    method: request.method,
    headers: {
      ...authHeaders(token),
      ...(request.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(request.body ? { body: JSON.stringify(request.body) } : {}),
    throw: false,
  }), deadline, signal);
  if (response.status < 200 || response.status >= 300) {
    const detail = errorMessageFromJson(response.json as unknown);
    throw new MineruPdfError(
      detail
        ? `MinerU v1 request failed with HTTP ${response.status}: ${detail}`
        : `MinerU v1 request failed with HTTP ${response.status}.`,
    );
  }
  const json = asRecord(response.json as unknown);
  if (!json) throw new MineruPdfError('MinerU v1 returned an invalid JSON response.');
  return json;
}

function arrayBufferFor(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer as ArrayBuffer
    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function createUploadedFile(
  baseUrl: string,
  token: string | undefined,
  filename: string,
  bytes: Uint8Array,
  deadline: number,
  signal?: AbortSignal,
): Promise<string> {
  const created = await requestJson(baseUrl, '/v1/uploads', token, {
    method: 'POST',
    body: {
      filename,
      bytes: bytes.byteLength,
      mime_type: mimeTypeForName(filename),
      purpose: 'parse',
    },
  }, deadline, signal);

  const uploadId = requiredString(created.id, 'upload id');
  const status = requiredString(created.status, 'upload status');
  if (status === 'completed') {
    return requiredString(asRecord(created.file)?.id, 'file id');
  }
  if (status !== 'pending') {
    throw new MineruPdfError(`MinerU v1 returned unsupported upload status "${status}".`);
  }

  const uploadUrl = resolveReturnedUrl(baseUrl, requiredString(created.upload_url, 'upload URL'));
  const uploadMethod = stringValue(created.upload_method) ?? 'PUT';
  if (uploadMethod !== 'PUT') {
    throw new MineruPdfError(`MinerU v1 returned unsupported upload method "${uploadMethod}".`);
  }
  const headers = stringHeaderMap(created.upload_headers);
  if (uploadUrl.origin === new URL(baseUrl).origin) {
    Object.assign(headers, authHeaders(token));
  }

  throwIfAborted(signal);
  const uploadResponse = await withDeadline(requestUrl({
    url: uploadUrl.href,
    method: 'PUT',
    headers,
    body: arrayBufferFor(bytes),
    throw: false,
  }), deadline, signal);
  if (uploadResponse.status < 200 || uploadResponse.status >= 300) {
    throw new MineruPdfError(`MinerU v1 byte upload failed with HTTP ${uploadResponse.status}.`);
  }

  const completed = await requestJson(
    baseUrl,
    `/v1/uploads/${encodeURIComponent(uploadId)}/complete`,
    token,
    { method: 'POST' },
    deadline,
    signal,
  );
  if (requiredString(completed.status, 'upload status') !== 'completed') {
    throw new MineruPdfError('MinerU v1 upload did not reach completed state.');
  }
  return requiredString(asRecord(completed.file)?.id, 'file id');
}

function jobFailureMessage(job: JsonRecord): string {
  const topError = asRecord(job.error);
  const topMessage = stringValue(topError?.message);
  if (topMessage) return topMessage;
  const files = job.files;
  if (Array.isArray(files)) {
    for (const value of files) {
      const file = asRecord(value);
      if (!file || file.status !== 'failed') continue;
      const message = stringValue(asRecord(file.error)?.message);
      if (message) return message;
    }
  }
  return `MinerU v1 parse job ended with status "${stringValue(job.status) ?? 'unknown'}".`;
}

async function waitForJob(
  baseUrl: string,
  token: string | undefined,
  initial: JsonRecord,
  deadline: number,
  signal?: AbortSignal,
): Promise<JsonRecord> {
  const jobId = requiredString(initial.job_id, 'job id');
  let job = initial;
  while (Date.now() < deadline) {
    const status = requiredString(job.status, 'job status');
    if (TERMINAL_JOB_STATES.has(status)) {
      if (status === 'failed' || status === 'canceled') {
        throw new MineruPdfError(jobFailureMessage(job));
      }
      return job;
    }
    if (!ACTIVE_JOB_STATES.has(status)) {
      throw new MineruPdfError(`MinerU v1 returned unsupported job status "${status}".`);
    }
    await withDeadline(
      new Promise(resolve => window.setTimeout(resolve, MINERU_POLL_INTERVAL_MS)),
      deadline,
      signal,
    );
    job = await requestJson(
      baseUrl,
      `/v1/parse/jobs/${encodeURIComponent(jobId)}`,
      token,
      { method: 'GET' },
      deadline,
      signal,
    );
  }
  throw new MineruPdfError('MinerU conversion timed out after 30 minutes.');
}

function markdownFileId(job: JsonRecord): string {
  const files = job.files;
  if (!Array.isArray(files)) throw new MineruPdfError('MinerU v1 returned no file results.');
  for (const value of files) {
    const file = asRecord(value);
    if (!file || file.status !== 'completed') continue;
    const outputs = asRecord(file.output_files);
    const markdown = asRecord(outputs?.markdown);
    const fileId = stringValue(markdown?.file_id);
    if (fileId) return fileId;
  }
  throw new MineruPdfError('MinerU v1 returned no Markdown output.');
}

async function downloadMarkdown(
  baseUrl: string,
  token: string | undefined,
  fileId: string,
  deadline: number,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  const response = await withDeadline(requestUrl({
    url: `${baseUrl}/v1/files/${encodeURIComponent(fileId)}/content`,
    method: 'GET',
    headers: authHeaders(token),
    throw: false,
  }), deadline, signal);
  if (response.status < 200 || response.status >= 300) {
    throw new MineruPdfError(`MinerU v1 Markdown download failed with HTTP ${response.status}.`);
  }
  const bytes = new Uint8Array(response.arrayBuffer);
  if (bytes.byteLength > PDF_CACHE_MAX_SINGLE_ENTRY_BYTES) {
    throw new MineruPdfError('MinerU Markdown output exceeds the cache entry size limit.');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new MineruPdfError('MinerU Markdown output is not valid UTF-8.');
  }
}

export async function convertPdfWithMineruV1(
  ctx: PdfConversionContext,
  configuredApiUrl: string,
): Promise<ConversionResult> {
  const baseUrl = normalizeApiRoot(configuredApiUrl);
  const token = ctx.mineruApiToken?.trim() || undefined;
  const bytes = new Uint8Array(await ctx.app.vault.adapter.readBinary(ctx.pdfFile.path));

  const sourceHash = await sha256Bytes(bytes, ctx.subtle);
  const cache = createPdfCache(ctx.app);
  const cacheKey = await hashCacheKey(
    `${sourceHash}:mineru-v1:${baseUrl}:markdown:v1`,
    ctx.subtle,
  );
  const cached = await cache.get(cacheKey);
  if (cached) return cached;

  const deadline = Date.now() + MINERU_TIMEOUT_MS;
  ctx.onMineruPhase?.('uploading');
  const fileId = await createUploadedFile(
    baseUrl,
    token,
    ctx.pdfFile.name,
    bytes,
    deadline,
    ctx.abortSignal,
  );

  ctx.onMineruPhase?.('waiting');
  const createdJob = await requestJson(baseUrl, '/v1/parse/jobs', token, {
    method: 'POST',
    body: {
      files: [{ source: { type: 'file_id', file_id: fileId } }],
      ocr_mode: 'auto',
      output_formats: ['markdown'],
    },
  }, deadline, ctx.abortSignal);
  const job = await waitForJob(baseUrl, token, createdJob, deadline, ctx.abortSignal);

  ctx.onMineruPhase?.('downloading');
  const markdown = await downloadMarkdown(
    baseUrl,
    token,
    markdownFileId(job),
    deadline,
    ctx.abortSignal,
  );
  const entry: ConversionResult = {
    markdown,
    metadata: {
      convertedAt: new Date().toISOString(),
      converter: 'mineru/v1',
    },
  };
  await cache.set(cacheKey, entry);
  return entry;
}
