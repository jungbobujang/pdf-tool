'use strict';
// jpeg-js 디코더를 브라우저 · Worker · node에서 "날 성분 값"으로 쓰기 위한 감싸개.
// CMYK JPEG은 브라우저 기본 디코더가 RGB로만 돌려줘서, PDF의 Decode 배열과 pdf.js 색 변환을
// 그대로 따르려면 성분 값이 필요하다. (jpeg-js 0.4.4, BSD-3-Clause)
const fs = require('fs');
const path = require('path');

const RAW_HELPER = `
function jpegRaw(bytes) {
  var j = new JpegImage();
  j.opts = { colorTransform: undefined, tolerantDecoding: true, maxResolutionInMP: 100, maxMemoryUsageInMB: 1024 };
  JpegImage.resetMaxMemoryUsage(1024 * 1024 * 1024);
  j.parse(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  var data = j.getData(j.width, j.height);
  return { w: j.width, h: j.height, comps: j.components.length, data: data };
}`;

let cached = null;
/** 브라우저 · Worker용 스크립트: self.JpegDecoder.raw(bytes) → {w, h, comps, data} */
function browserScript() {
  if (!cached) {
    const src = fs.readFileSync(path.join(require.resolve('jpeg-js/package.json'), '..', 'lib', 'decoder.js'), 'utf8');
    cached = `/* jpeg-js 0.4.4 decoder (BSD-3-Clause), 날 성분 값 감싸개 */\n(function () {\nvar module = undefined;\nvar window = self;\n${src}\n${RAW_HELPER}\nself.JpegDecoder = { raw: jpegRaw };\n})();\n`;
  }
  return cached;
}

/** node용: raw(bytes) 함수 */
function nodeRaw() {
  const vm = require('vm');
  const sandbox = { self: {}, Uint8Array, Buffer, console, Math, Error, RangeError, TypeError };
  sandbox.self = sandbox;
  vm.runInNewContext(browserScript(), sandbox);
  return sandbox.JpegDecoder.raw;
}

module.exports = { browserScript, nodeRaw };
