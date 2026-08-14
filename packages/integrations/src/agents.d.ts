// SPDX-License-Identifier: MIT
// Type shims for ESM-only proxy agent packages. Runtime require(esm) is supported by
// Node >=22.12 (verified in-repo); these declarations cover the small API we use.
declare module "http-proxy-agent" {
  export class HttpProxyAgent {
    constructor(proxy: string);
  }
}
declare module "https-proxy-agent" {
  export class HttpsProxyAgent {
    constructor(proxy: string);
  }
}
declare module "socks-proxy-agent" {
  export class SocksProxyAgent {
    constructor(proxy: string);
  }
}
declare module "@ffprobe-installer/ffprobe" {
  /** Static per-platform ffprobe binary, resolved at install. CJS: `module.exports = {...}`. */
  const ffprobe: { path: string; version: string; url: string };
  export default ffprobe;
}
