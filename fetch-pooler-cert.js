const net = require("net");
const tls = require("tls");
const fs = require("fs");
const path = require("path");

const HOST = "aws-0-us-west-1.pooler.supabase.com";
const PORT = 5432;

const s = net.connect(PORT, HOST, () => {
  // PostgreSQL SSLRequest (protocol 80877103)
  s.write(Buffer.from([0x00, 0x00, 0x00, 0x08, 0x04, 0xd2, 0x16, 0x2f]));
});

s.on("error", (e) => { console.error("NET FAIL:", e.message); process.exit(1); });

let handled = false;
s.on("data", (d) => {
  if (handled) return;
  if (d.length < 1) return;
  handled = true;
  if (d[0] !== 0x53) { // 'S' means SSL supported
    console.error("Server refused SSL:", String.fromCharCode(d[0]));
    process.exit(1);
  }
  const tlsSock = tls.connect({ socket: s, servername: HOST, rejectUnauthorized: false }, () => {
    const cert = tlsSock.getPeerCertificate(true);
    const chain = [];
    let cur = cert, depth = 0;
    while (cur && depth < 5) {
      chain.push(cur);
      if (!cur.issuerCertificate || cur.issuerCertificate === cur) break;
      cur = cur.issuerCertificate;
      depth++;
    }
    const outDir = path.join(__dirname, "certs");
    fs.mkdirSync(outDir, { recursive: true });
    const pemPath = path.join(outDir, "supabase-pooler-chain.pem");
    const pem = chain
      .map((c) => "-----BEGIN CERTIFICATE-----\n" + c.raw.toString("base64").replace(/.{1,64}/g, "$&\n") + "-----END CERTIFICATE-----")
      .join("\n");
    fs.writeFileSync(pemPath, pem);
    console.log("Saved", chain.length, "certificate(s) to", pemPath);
    for (const c of chain) {
      console.log("-", c.subject.CN || c.subject.O || "(root)", "| issuer:", (c.issuer && (c.issuer.CN || c.issuer.O)) || "self-signed", "| valid:", c.valid_from, "->", c.valid_to);
    }
    process.exit(0);
  });
  tlsSock.on("error", (e) => { console.error("TLS FAIL:", e.message); process.exit(1); });
});
