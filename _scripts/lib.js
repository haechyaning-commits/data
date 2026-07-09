const https = require('https');
const http = require('http');

const proxyUrl = new URL(process.env.HTTPS_PROXY || process.env.https_proxy || 'http://127.0.0.1:33749');

function proxyRequest(targetHost, path, { method = 'GET', headers = {}, body = null, targetPort = 443, timeoutMs = 25000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (req) req.destroy();
      reject(new Error(`proxyRequest timed out after ${timeoutMs}ms: ${targetHost}${path}`));
    }, timeoutMs);
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };

    req = http.request({
      host: proxyUrl.hostname, port: proxyUrl.port,
      method: 'CONNECT',
      path: targetHost + ':' + targetPort,
    });
    req.on('connect', (res, socket) => {
      socket.on('error', () => {}); // ignore post-response ECONNRESET on tunnel teardown
      const opts = {
        socket, servername: targetHost, host: targetHost, path, method,
        headers: Object.assign({ Host: targetHost, 'User-Agent': 'Mozilla/5.0' }, headers),
      };
      const r = https.request(opts, (resp) => {
        let chunks = [];
        resp.on('data', (c) => chunks.push(c));
        resp.on('end', () => {
          finish(resolve, { status: resp.statusCode, headers: resp.headers, body: Buffer.concat(chunks) });
        });
      });
      r.on('error', (e) => finish(reject, e));
      if (body) r.write(body);
      r.end();
    });
    req.on('error', (e) => finish(reject, e));
    req.end();
  });
}

module.exports = { proxyRequest };
