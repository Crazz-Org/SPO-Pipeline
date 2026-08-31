'use strict';
// Tests for orchestrator/http.js -- the one file in this repo that opens a real socket, so
// (per its own header comment) it is the one exception to "every caller fakes deps.httpRequest":
// a promise that can fail to settle is exactly the class of bug a mocked httpRequest can never
// reproduce, because a hand-written mock always resolves-or-rejects by construction.
//
// This spins up a REAL local HTTPS server with a self-signed cert (fixture below, valid to 2036,
// CN=localhost with SANs for both `localhost` and `127.0.0.1`) rather than weakening http.js's
// https-only check or adding a TLS-bypass seam to production code. Trust for the self-signed cert
// is granted the same way any Node HTTPS client trusts an extra CA -- by adding it to the agent
// used for the request -- via `https.globalAgent.options.ca`, restored by a t.after() hook.
// http.js itself is untouched by this: it never sees a test hook, it just uses the default agent
// like any other caller would.
//
// EVERY test here has a per-test `timeout`, and -- this is the load-bearing part -- every server
// and every globalAgent mutation is torn down from `t.after()`, never from a `finally` inside the
// test body. A regression that reintroduces the original "promise never settles" bug leaves the
// test body suspended at its `await` FOREVER: node:test reports the timeout failure, but a
// `finally` in that body never runs, so the fixture server keeps listening, the event loop never
// drains, and `node --test` hangs instead of exiting -- a hung CI run is indistinguishable from
// an infrastructure problem. node:test DOES run t.after() hooks when it aborts a timed-out test,
// so cleanup happens on that path too and the suite fails loudly and fast (verified by reverting
// http.js: 2 tests fail with `testTimeoutFailure` and the run still terminates normally).

const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('https');

const { httpRequest } = require('../orchestrator/http');

// Self-signed fixture cert/key, CN=localhost, SAN DNS:localhost + IP:127.0.0.1, valid 2026-2036.
// Generated once with:
//   openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 3650 -nodes \
//     -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
const CERT = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUGQur+JI7pW7/eYOXmsHhV7oZvXgwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDgzMTEwMzU1NloXDTM2MDgy
ODEwMzU1NlowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAlonvdwbGJYD6fsMmb1vy16ADuHZSenGGuFggU3/4TmR5
VPaFofHv8muJdAEeOzzqI/krCkAPHBJ9P1nWwBDfFytrY9qFH3KEUGxUto8eqGZh
2USXkIw3x/IZ8c7I6MvPCzoqk8u28sUCrODqb+N2btBg6nSamOTIIB3EKAkkCJWL
Q4OgxWVsLsXMdo55CkXFFiCx9MiajGuTuIJ4cYY4DpP2F/pc2FXEt3jhHcKxvPyO
lo1OcgUzS/plR+uiDg2KcHeV0O4MYuaWgwzlor/onpSwZ08MtSb8sY3FB0Uf4iPd
axOyzwtzTZdYP5b+YPGb3VFvUSYpytAqqXWkh0YhfwIDAQABo28wbTAdBgNVHQ4E
FgQUsDTFEak08aNW/tg4k8HkixutLscwHwYDVR0jBBgwFoAUsDTFEak08aNW/tg4
k8HkixutLscwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SH
BH8AAAEwDQYJKoZIhvcNAQELBQADggEBAGW727bT/iP+ZtkKmWWa0WxU9dYD4a9a
+2PEO4wn6sn1boQAi+xmMm76eMcMmZZPmK02DS7XeNL/NDVTU/qdn4Qi+Q37tdhS
HnZ3OTcjos0ALMMjLjsS57RrTvkVsDwnfnC512bZRjrpFCr3XNW0VHe3IYyhXlao
MiPeUkK2gknErmQ+3i4AsnqGm6dfKHnoSkzDdl82mM0I67ivFBVIpScrAeZoxa6I
LrSjV+yRoUJ06cdlmQOsmazEqMOv4E9I9UsWW0FVO7OKV+n/A2JWU4ZRCXResFgQ
YRMKyS4ZPD9LyTi24LeGMpzwCKhUJmYh2q0U1REUqkyDV4zgoKHpi5I=
-----END CERTIFICATE-----
`;

const KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCWie93BsYlgPp+
wyZvW/LXoAO4dlJ6cYa4WCBTf/hOZHlU9oWh8e/ya4l0AR47POoj+SsKQA8cEn0/
WdbAEN8XK2tj2oUfcoRQbFS2jx6oZmHZRJeQjDfH8hnxzsjoy88LOiqTy7byxQKs
4Opv43Zu0GDqdJqY5MggHcQoCSQIlYtDg6DFZWwuxcx2jnkKRcUWILH0yJqMa5O4
gnhxhjgOk/YX+lzYVcS3eOEdwrG8/I6WjU5yBTNL+mVH66IODYpwd5XQ7gxi5paD
DOWiv+ielLBnTwy1JvyxjcUHRR/iI91rE7LPC3NNl1g/lv5g8ZvdUW9RJinK0Cqp
daSHRiF/AgMBAAECggEABMnzimOhRw0mKtqAwlci+mAL7kDOro17qH6eh07RXTEO
DmQJ6+pwjyjY8Q3zYmq1f2/MQjcNI//56FuDx41h2MYCqbpdtMU7AfydlJx98Fko
G2DMD4bzuVJxfS3uWerYiyC5ElrkgYQ/PwpSpZI6BhwZO9bPb4tg9cCXU7diuZEi
dzp7ZVX/4QgsYY2qt8OrKY8Sjp6QmpaorGPbhPBT4McMXJ//lKXii1j57Pa4mTh7
98j+gGcE3DktzAdVzrRIqnnx5iMjP0flddi3LIuzMOVhEoMS48DEnPc5lN6uaHr+
xisXJ0Xz0Mqxg9qv2+MzKqUoh3JBzsY37GSki7mnsQKBgQDNOdB5B0dtvHfJ52kE
1ruMeYhQecYh/Pb1bqGBxK6qwws5/9IzOrwqyN5j+IMHJDZKc2SuwXyYoLs14X6w
44UQhbBmQhvAy7nmsKvK0fci7hssMxOVPZ0DkcU/+NC3gefIiU/qNCHgO6I98eqA
v51cjVa9qKnBQDjOulZiz+0WrwKBgQC7yHaFmSY3DLAxS2FC07xJxkuKOUfcmKH1
KFpVbxN/KT5OUV/dPeNgHA3mXWMqfcqFLw2897WTNdUxa8/pZ6wPkW7+7B48UB87
YrMBFEDVVWAKgq2dD/xetJsptVZPY3BrweBFztHdY/Xss3F2lLxY9DbMrg7tzq0M
aa4xkJpWMQKBgEEUt37aBxXOsbIul4g4TIuUstzKcUGwBeT5K3CKndV7OuEutksW
sjtjLdtIIM0v96OOinw80bVZK2U/2DxiOn1t1+3lwwVV1eNJXYFZKmVCWw2eOPSX
8GYEYSgTUKURJh7bJKOh2qhQYPgB8prXqSCDleFZTlQBeMJeJyz4wTfzAoGBAKJu
T19Wz0CVAB9TtejpYBhsp1EEJU4C1S1L33/BGhtHoLZ8GzEz5GdxPPDEXRAXSUQV
JIwNtQmGakhamripzaKVyW5G7gx7vdhPkslfLImcVPwid2zBtCpzjTfxvJvlRwxe
4tFfihc37TT3LzFEjPthG7nG4fEAcp2nGF+VVnsxAoGBAMkDto85TaTMw1AYRY9I
vNdCAiyuUawsvuBYE4+ApywSDcgUlzoedELb24lNVmRLLQG6M1vodr3XhY9h1WK5
JwmT2y6ckovV/FCmgzMb9Q5FUCnRG6cUzmKLTyMYsSNixJM6L4Ym/DigxgVYbsoC
V8NWbC1qj6jn+J8Ls0oI3FVl
-----END PRIVATE KEY-----
`;

// Grants trust for the fixture cert on the SAME agent http.js's https.request() implicitly uses
// (no `agent` option is ever passed by http.js, so every call goes through https.globalAgent).
// This is a test-harness trick, not a production seam: http.js's code is completely unaware of
// it, and the https-only protocol check is untouched.
function trustFixtureCa() {
  const prev = https.globalAgent.options.ca;
  https.globalAgent.options.ca = CERT;
  return () => {
    https.globalAgent.options.ca = prev;
  };
}

function startServer(handler) {
  return new Promise((resolve) => {
    const server = https.createServer({ key: KEY, cert: CERT }, handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `https://127.0.0.1:${port}` });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

// Starts a fixture server and registers BOTH teardowns (globalAgent.ca, the listening server) on
// the test context. See this file's header: a t.after() hook still runs when node:test aborts a
// test that timed out, a `finally` inside a body stuck on a never-settling await does not.
async function serverFor(t, handler) {
  const restoreCa = trustFixtureCa();
  const { server, url } = await startServer(handler);
  t.after(async () => {
    restoreCa();
    await closeServer(server);
  });
  return url;
}

// ---- truncation: the bug this action fixes -----------------------------------------------

test('httpRequest: a response over maxBytes resolves with truncated:true and does not hang', { timeout: 5000 }, async (t) => {
  const url = await serverFor(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    // Write well past maxBytes in one go so the handler sees `received > maxBytes` on a single
    // 'data' event, then keep the connection open a moment -- if destroy() alone doesn't settle
    // the promise, this is exactly the hang the bug produced (res.end() never gets a chance to
    // run, so 'end' would never fire either).
    res.write(Buffer.alloc(2000, 'x'));
    setTimeout(() => {
      try {
        res.end();
      } catch {
        // Client already destroyed its side -- fine, this is just making sure a slow server
        // doesn't mask the bug by finishing before destroy() would have mattered.
      }
    }, 50);
  });
  const result = await httpRequest(url, { maxBytes: 1000 });
  assert.equal(result.truncated, true);
  assert.equal(result.status, 200);
  assert.ok(result.body.length <= 1000, `expected body capped at maxBytes, got ${result.body.length}`);
});

test('httpRequest: a response under the cap is unaffected (truncated:false, full body)', { timeout: 5000 }, async (t) => {
  const url = await serverFor(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('hello world');
  });
  const result = await httpRequest(url, { maxBytes: 1000 });
  assert.equal(result.truncated, false);
  assert.equal(result.status, 200);
  assert.equal(result.body.toString('utf8'), 'hello world');
});

// ---- settle-exactly-once ------------------------------------------------------------------

test('httpRequest: the promise settles exactly once even when destroy() also triggers a close/error', { timeout: 5000 }, async (t) => {
  const url = await serverFor(t, (req, res) => {
    res.writeHead(200);
    res.write(Buffer.alloc(5000, 'y'));
    // Deliberately never call res.end() -- the only way this response ever terminates is via the
    // client's own res.destroy() on the truncation path. If that destroy() causes a duplicate
    // settle (a second resolve, or a reject after the resolve), a bug in settleOnce would surface
    // here as an unhandled promise rejection or a second value racing the first -- `await` below
    // only ever sees the first settle, by Promise semantics, so this test mainly documents intent
    // and relies on Node's own unhandledRejection crashing the test process if one leaks.
  });
  const result = await httpRequest(url, { maxBytes: 1000 });
  assert.equal(result.truncated, true);
  // Give any late 'close'/'error' event from the destroy() a tick to fire and prove it's inert.
  await new Promise((r) => setTimeout(r, 100));
});

test('httpRequest: a server that closes the connection with no body and no end still settles (rejects)', { timeout: 5000 }, async (t) => {
  const url = await serverFor(t, (req) => {
    // Destroy the underlying socket before writing a response at all -- no headers, no 'end',
    // just a premature close. Node surfaces this to the client as a request-level 'error'
    // (ECONNRESET), so this covers the req.on('error') leg of settleOnce, not the res 'close'
    // catch-all; it is deliberately matched on the error CODE rather than accepting any
    // rejection, so a broken fixture cert (a TLS rejection) can never make it pass for the
    // wrong reason.
    req.socket.destroy();
  });
  await assert.rejects(
    () => httpRequest(url, { maxBytes: 1000 }),
    (err) => {
      assert.ok(
        err.code === 'ECONNRESET' || /connection closed before the response completed/.test(err.message),
        `expected a premature-close rejection, got: ${err.code || ''} ${err.message}`
      );
      return true;
    }
  );
});

// ---- timeout path still works ---------------------------------------------------------------

test('httpRequest: the timeout path still rejects when the server never responds', { timeout: 5000 }, async (t) => {
  const url = await serverFor(t, () => {
    // Never call res.end()/res.write() and never destroy -- the request-level `timeout` option
    // is what must fire here.
  });
  await assert.rejects(() => httpRequest(url, { maxBytes: 1000, timeoutMs: 100 }), /timed out after 100ms/);
});

test('httpRequest: a timeout that fires after the response already completed does not double-settle', { timeout: 5000 }, async (t) => {
  const url = await serverFor(t, (req, res) => {
    res.writeHead(200);
    res.end('quick');
  });
  // A generous timeout that will never actually fire before 'end' -- this test's job is just to
  // confirm the normal fast path is unaffected by the timeout wiring now going through
  // settleOnce, not to force the race (node:test itself would fail loudly on an
  // unhandledRejection if settleOnce ever let a late timeout reject an already-resolved call).
  const result = await httpRequest(url, { maxBytes: 1000, timeoutMs: 3000 });
  assert.equal(result.body.toString('utf8'), 'quick');
});

// ---- still refuses non-https ------------------------------------------------------------------

test('httpRequest: still refuses a plain http:// URL (unchanged by this action)', async () => {
  await assert.rejects(() => httpRequest('http://127.0.0.1:1/x'), /refusing a non-https URL/);
});
