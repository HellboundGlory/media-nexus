// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import { CardigannProvider } from "./index";

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

interface Req { method: string; path: string; cookie: string; body: string; }

async function listen(handler: (req: IncomingMessage, res: ServerResponse, url: URL, body: string) => void, collect: Req[] = []): Promise<string> {
  const server = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      collect.push({ method: req.method ?? "GET", path: url.pathname, cookie: req.headers.cookie ?? "", body: b });
      handler(req, res, url, b);
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const SEARCH_HTML = `<table><tbody><tr class="row"><td class="t"><a href="/d/1">Show.S01E01.1080p.WEB-DL</a></td><td class="s">99</td></tr></tbody></table>`;

describe("Cardigann login engine (Stage 2)", () => {
  it("post method: posts credentials, captures session cookie, and carries it on search; session round-trips without re-login", async () => {
    const log: Req[] = [];
    let loginPosts = 0;
    const url = await listen((_req, res, _u, body) => {
      if (_u.pathname === "/login") {
        loginPosts++;
        expect(body).toContain("username=bob");
        expect(body).toContain("password=secret");
        res.writeHead(200, { "set-cookie": "session=abc123; Path=/; HttpOnly" });
        res.end("ok");
      } else if (_u.pathname === "/index.php") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end('<a href="logout.php">logout</a>');
      } else if (_u.pathname === "/browse.php") {
        if (_req.headers.cookie?.includes("session=abc123")) {
          res.writeHead(200, { "content-type": "text/html" });
          res.end(SEARCH_HTML);
        } else {
          res.writeHead(403); res.end("no auth");
        }
      } else {
        res.writeHead(404); res.end();
      }
    }, log);

    const defText = `name: PostTrack
settings:
  - name: baseUrl
    type: text
    default: ${url}
  - name: username
    type: text
  - name: password
    type: password
login:
  path: login
  method: post
  inputs:
    username: "{{ .Config.username }}"
    password: "{{ .Config.password }}"
  test:
    path: index.php
    selector: 'a[href="logout.php"]'
search:
  paths:
    - path: browse.php
      inputs:
        q: "{{ .Keywords }}"
  rows:
    selector: tr.row
  fields:
    title:
      selector: td.t a
    seeders:
      selector: td.s`;

    const p1 = new CardigannProvider({ key: "p1", protocol: "torrent", definitionText: defText, settings: { baseUrl: url, username: "bob", password: "secret" } });
    const r1 = await p1.search({ mediaType: "series", query: "show" });
    expect(r1).toHaveLength(1);
    expect(loginPosts).toBe(1);
    // session captured into the raw (serialized) session
    expect(p1.session).toContain("session");
    const cookieRecord = log.find((r) => r.path === "/browse.php");
    expect(cookieRecord?.cookie).toContain("session=abc123");

    // A fresh provider restored from the persisted session must NOT re-login (test passes).
    const p2 = new CardigannProvider({ key: "p2", protocol: "torrent", definitionText: defText, settings: { baseUrl: url, username: "bob", password: "secret" }, sessionState: p1.session });
    const r2 = await p2.search({ mediaType: "series", query: "show" });
    expect(r2).toHaveLength(1);
    expect(loginPosts).toBe(1); // no second POST /login
  });

  it("cookie method: session comes from a configured cookie string and is sent on search", async () => {
    const log: Req[] = [];
    const url = await listen((req, res, _u) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(SEARCH_HTML);
    }, log);
    const defText = `name: CookieTrack
settings:
  - name: baseUrl
    type: text
    default: ${url}
  - name: cookie
    type: password
login:
  method: cookie
  inputs:
    cookie: "{{ .Config.cookie }}"
search:
  paths:
    - path: browse.php
  rows:
    selector: tr.row
  fields:
    title:
      selector: td.t a
    seeders:
      selector: td.s`;
    const p = new CardigannProvider({ key: "c1", protocol: "torrent", definitionText: defText, settings: { baseUrl: url, cookie: "uid=5; pass=xyz" } });
    const r = await p.search({ mediaType: "series", query: "show" });
    expect(r).toHaveLength(1);
    expect(log[0].cookie).toContain("uid=5");
    expect(log[0].cookie).toContain("pass=xyz");
  });

  it("form method: gets login page, extracts selectorinputs (csrf _token), posts to the form action, and sends session on search", async () => {
    const log: Req[] = [];
    const url = await listen((_req, res, u, body) => {
      if (u.pathname === "/login") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<html><form action="/login-action" method="post"><input name="_token" value="tok123"/><input name="username"/></form></html>`);
      } else if (u.pathname === "/login-action") {
        expect(body).toContain("_token=tok123");
        expect(body).toContain("username=bob");
        res.writeHead(302, { "set-cookie": "sid=form1; Path=/", location: "/index.php" });
        res.end();
      } else if (u.pathname === "/index.php") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end('<a href="logout.php">logout</a>');
      } else if (u.pathname === "/browse.php") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(SEARCH_HTML);
      } else { res.writeHead(404); res.end(); }
    }, log);
    const defText = `name: FormTrack
settings:
  - name: baseUrl
    type: text
    default: ${url}
  - name: username
    type: text
  - name: password
    type: password
login:
  path: login
  method: form
  form: 'form[action="/login-action"]'
  inputs:
    username: "{{ .Config.username }}"
    password: "{{ .Config.password }}"
  selectorinputs:
    _token:
      selector: 'input[name="_token"]'
      attribute: value
  test:
    path: index.php
    selector: 'a[href="logout.php"]'
search:
  paths:
    - path: browse.php
  rows:
    selector: tr.row
  fields:
    title:
      selector: td.t a
    seeders:
      selector: td.s`;
    const p = new CardigannProvider({ key: "f1", protocol: "torrent", definitionText: defText, settings: { baseUrl: url, username: "bob", password: "secret" } });
    const r = await p.search({ mediaType: "series", query: "show" });
    expect(r).toHaveLength(1);
    expect(p.session).toContain("sid");
    expect(log.find((q) => q.path === "/browse.php")?.cookie).toContain("sid=form1");
  });

  it("error block: login failure throws rather than silently proceeding", async () => {
    const url = await listen((_req, res, u) => {
      if (u.pathname === "/login") { res.writeHead(200, { "content-type": "text/html" }); res.end('<div id="login-error">Wrong password</div>'); }
      else { res.writeHead(200, { "content-type": "text/html" }); res.end(SEARCH_HTML); }
    });
    const defText = `name: ErrTrack
settings:
  - name: baseUrl
    type: text
    default: ${url}
  - name: username
    type: text
  - name: password
    type: password
login:
  path: login
  method: post
  inputs:
    username: "{{ .Config.username }}"
    password: "{{ .Config.password }}"
  error:
    - selector: '#login-error'
search:
  paths:
    - path: browse.php
  rows:
    selector: tr.row
  fields:
    title:
      selector: td.t a
    seeders:
      selector: td.s`;
    const p = new CardigannProvider({ key: "e1", protocol: "torrent", definitionText: defText, settings: { baseUrl: url, username: "bob", password: "bad" } });
    await expect(p.search({ mediaType: "series", query: "show" })).rejects.toThrow(/login failed/);
  });

  it("session-state expiry: a restored session that fails the test block triggers a re-login", async () => {
    let loginCount = 0;
    let authed = false;
    const url = await listen((_req, res, u, body) => {
      if (u.pathname === "/login") {
        loginCount++;
        expect(body).toContain("username=bob");
        authed = true; // server now considers the session live
        res.writeHead(200, { "set-cookie": "session=live; Path=/" });
        res.end("ok");
      } else if (u.pathname === "/index.php") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(authed ? '<a href="logout.php">logout</a>' : "<html>login page</html>");
      } else if (u.pathname === "/browse.php") {
        if (_req.headers.cookie?.includes("session=live")) { res.writeHead(200); res.end(SEARCH_HTML); }
        else { res.writeHead(403); res.end("no auth"); }
      } else { res.writeHead(404); res.end(); }
    });

    const defText = `name: ExpiryTrack
settings:
  - name: baseUrl
    type: text
    default: ${url}
  - name: username
    type: text
  - name: password
    type: password
login:
  path: login
  method: post
  inputs:
    username: "{{ .Config.username }}"
    password: "{{ .Config.password }}"
  test:
    path: index.php
    selector: 'a[href="logout.php"]'
search:
  paths:
    - path: browse.php
  rows:
    selector: tr.row
  fields:
    title:
      selector: td.t a
    seeders:
      selector: td.s`;

    // Provider restored with a stale/bogus session: the test block fails, so it re-logs in
    // (POST /login once) and then searches with the fresh cookie.
    const p = new CardigannProvider({
      key: "x1", protocol: "torrent", definitionText: defText,
      settings: { baseUrl: url, username: "bob", password: "secret" },
      sessionState: JSON.stringify([{ name: "old", value: "dead" }]),
    });
    const r = await p.search({ mediaType: "series", query: "show" });
    expect(r).toHaveLength(1);
    expect(loginCount).toBe(1);
  });
});
