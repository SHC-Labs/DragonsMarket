#!/usr/bin/env node
import http from "node:http";

const closes = {};
for (let i = 2; i < process.argv.length; i += 2) closes[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];

const minutes = (from, count) => Array.from({ length: count }, (_, i) => from + i * 60);

const routes = [
  [/^\/products\/[^/]+\/candles$/, (q) => {
    const from = Date.parse(q.get("start")) / 1000;
    const count = (Date.parse(q.get("end")) / 1000 - from) / 60;
    return minutes(from, count).reverse().map((t) => [t, 0, 0, 0, Number(closes.coinbase), 1]);
  }],
  [/^\/0\/public\/OHLC$/, (q) => ({
    error: [],
    result: { [q.get("pair")]: minutes(Number(q.get("since")), 5).map((t) => [t, "0", "0", "0", closes.kraken, "0", "1", 1]), last: 0 },
  })],
  [/^\/api\/v2\/ohlc\/[^/]+\/$/, (q) => ({
    data: { ohlc: minutes(Number(q.get("start")), Number(q.get("limit"))).map((t) => ({ timestamp: String(t), close: closes.bitstamp, volume: "1" })) },
  })],
];

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://exchanges");
  const route = routes.find(([path]) => path.test(url.pathname));
  res.writeHead(route ? 200 : 404, { "content-type": "application/json" });
  res.end(JSON.stringify(route ? route[1](url.searchParams) : { error: "no such route" }));
});
server.listen(0, "127.0.0.1", () => console.log(`exchanges listening on http://127.0.0.1:${server.address().port}`));
