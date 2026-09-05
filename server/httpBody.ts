/** Fetch headers AND body under one deadline, with bounded buffering. */
export async function fetchBoundedBody(url: string, options: RequestInit = {}, timeoutMs = 12_000, maxBytes = 8_000_000) {
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const timeout = setTimeout(() => controller.abort(new Error('HTTP response deadline exceeded')), timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(url, { ...options, signal });
    if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('HTTP response exceeds byte limit');
    reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('HTTP response exceeds byte limit');
      chunks.push(value);
    }
    return { response, bytes: Buffer.concat(chunks, size) };
  } catch (error) {
    controller.abort();
    throw error;
  } finally {
    clearTimeout(timeout);
    reader?.releaseLock();
  }
}
