/* 용량 줄이기를 화면과 따로 돌리는 Web Worker (OffscreenCanvas가 있을 때만 쓴다). */
/* global Compress */
importScripts('/vendor/pdf-lib.min.js', '/vendor/pako.min.js', `compress.js${self.location.search}`);

const codec = Compress.browserCodec();

self.onmessage = async (e) => {
  const { id, cmd, bytes, target } = e.data;
  const onProgress = (p) => self.postMessage({ id, progress: p });
  try {
    const r = cmd === 'analyze'
      ? await Compress.analyzePdf(bytes, codec, { onProgress })
      : await Compress.compressPdf(bytes, target, codec, { onProgress });
    self.postMessage({ id, result: r }, r.bytes ? [r.bytes.buffer] : []);
  } catch (err) {
    const stack = String((err && err.stack) || '').split('\n').slice(0, 8).join('\n');
    self.postMessage({ id, error: { name: err && err.name, message: String((err && err.message) || err), stack } });
  }
};
