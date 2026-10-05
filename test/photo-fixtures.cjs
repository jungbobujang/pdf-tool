// 사진 작업실 검사용 사진: JPEG(jpeg-js) + EXIF(휴대폰 기종 · 위치(GPS) · 찍은 날). 화면 검사 · verify가 같이 쓴다.
'use strict';
const jpeg = require('jpeg-js');

/** EXIF APP1 덩어리: IFD0(Make · ExifIFD · GPS) · ExifIFD(DateTimeOriginal) · GPS IFD(GPSLatitudeRef) */
function exifApp1({ make = 'TestPhone', date = '2026:10:05 09:12:33', gps = true } = {}) {
  const buf = new Uint8Array(256);
  const dv = new DataView(buf.buffer);
  buf[0] = 0x49; buf[1] = 0x49; dv.setUint16(2, 42, true); dv.setUint32(4, 8, true);
  const n0 = gps ? 3 : 2;
  dv.setUint16(8, n0, true);
  let data = 8 + 2 + n0 * 12 + 4;
  const makeBytes = [...make].map((c) => c.charCodeAt(0)).concat([0]);
  let e = 10;
  dv.setUint16(e, 0x010f, true); dv.setUint16(e + 2, 2, true); dv.setUint32(e + 4, makeBytes.length, true); dv.setUint32(e + 8, data, true);
  buf.set(makeBytes, data); data += makeBytes.length; if (data % 2) data++;
  e += 12;
  const exifAt = data; data += 2 + 12 + 4;
  dv.setUint16(e, 0x8769, true); dv.setUint16(e + 2, 4, true); dv.setUint32(e + 4, 1, true); dv.setUint32(e + 8, exifAt, true);
  e += 12;
  let gpsAt = 0;
  if (gps) { gpsAt = data; data += 2 + 12 + 4; dv.setUint16(e, 0x8825, true); dv.setUint16(e + 2, 4, true); dv.setUint32(e + 4, 1, true); dv.setUint32(e + 8, gpsAt, true); e += 12; }
  dv.setUint32(e, 0, true);
  const dateAt = data;
  const dateBytes = [...date].map((c) => c.charCodeAt(0)).concat([0]);
  data += dateBytes.length;
  dv.setUint16(exifAt, 1, true); dv.setUint16(exifAt + 2, 0x9003, true); dv.setUint16(exifAt + 4, 2, true); dv.setUint32(exifAt + 6, 20, true); dv.setUint32(exifAt + 10, dateAt, true); dv.setUint32(exifAt + 14, 0, true);
  buf.set(dateBytes, dateAt);
  if (gps) { dv.setUint16(gpsAt, 1, true); dv.setUint16(gpsAt + 2, 0x0001, true); dv.setUint16(gpsAt + 4, 2, true); dv.setUint32(gpsAt + 6, 2, true); buf[gpsAt + 10] = 0x4e; dv.setUint32(gpsAt + 14, 0, true); }
  const tiff = buf.subarray(0, data);
  const seg = new Uint8Array(10 + tiff.length);
  const L = 2 + 6 + tiff.length;
  seg[0] = 0xff; seg[1] = 0xe1; seg[2] = L >> 8; seg[3] = L & 0xff;
  seg.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4);
  seg.set(tiff, 10);
  return seg;
}

/** 사진 같은 JPEG(그라데이션 + 잡티). exif: false면 정보 없이 */
function makePhoto(w, h, { seed = 1, exif = {}, quality = 90 } = {}) {
  const data = Buffer.alloc(w * h * 4);
  let s = seed;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const n = (s >> 16) & 31;
      const i = (y * w + x) * 4;
      data[i] = ((x * 255) / w + n) & 255;
      data[i + 1] = ((y * 255) / h + n) & 255;
      data[i + 2] = (((x + y) * 128) / (w + h) + 60 + n) & 255;
      data[i + 3] = 255;
    }
  }
  const raw = jpeg.encode({ data, width: w, height: h }, quality).data;
  if (exif === false) return Buffer.from(raw);
  return Buffer.concat([raw.subarray(0, 2), Buffer.from(exifApp1(exif)), raw.subarray(2)]);
}

module.exports = { exifApp1, makePhoto };
