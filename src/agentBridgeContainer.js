// @ts-check

// Container side of the SSH agent forwarding bridge. This runs inside the container
// via the server's own node (`node agentBridgeContainer.js <socketPath>` is passed to
// `docker exec` through `-e`). It listens on a unix socket and multiplexes every
// connection to it over the exec's stdio back to the extension host, which dials the
// host's real $SSH_AUTH_SOCK.
//
// Frames are [type:u8][channel:u32be][len:u32be][payload]. This side opens channels
// (type 0) as apps connect; both sides exchange data (type 1) and close (type 2).

const net = require("net");
const fs = require("fs");

const SOCK = process.argv[1];

try {
  fs.unlinkSync(SOCK);
} catch (e) {
  // Nothing to clean up if the socket does not already exist.
}

/** @type {Record<number, net.Socket>} */
const channels = {};
let nextId = 1;
let buf = Buffer.alloc(0);

/**
 * @param {number} type
 * @param {number} id
 * @param {Buffer} [payload]
 */
function send(type, id, payload) {
  const header = Buffer.alloc(9);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(id, 1);
  header.writeUInt32BE(payload ? payload.length : 0, 5);
  process.stdout.write(payload ? Buffer.concat([header, payload]) : header);
}

process.stdin.on("data", (data) => {
  const chunk = typeof data === "string" ? Buffer.from(data) : data;
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    if (buf.length < 9) break;
    const type = buf.readUInt8(0);
    const id = buf.readUInt32BE(1);
    const len = buf.readUInt32BE(5);
    if (buf.length < 9 + len) break;
    const payload = buf.subarray(9, 9 + len);
    buf = buf.subarray(9 + len);
    const socket = channels[id];
    if (type === 1) {
      if (socket) socket.write(payload);
    } else if (type === 2) {
      if (socket) {
        delete channels[id];
        socket.end();
      }
    }
  }
});

process.stdin.on("end", () => process.exit(0));

const srv = net.createServer((socket) => {
  const id = nextId++;
  channels[id] = socket;
  send(0, id);
  socket.on("data", (d) => send(1, id, d));
  socket.on("close", () => {
    if (channels[id]) {
      delete channels[id];
      send(2, id);
    }
  });
  socket.on("error", () => {
    if (channels[id]) {
      delete channels[id];
      send(2, id);
    }
  });
});

srv.on("error", (e) => {
  process.stderr.write("agent-bridge: " + ((e && e.message) || e) + "\n");
  process.exit(1);
});

srv.listen(SOCK, () => {
  try {
    fs.chmodSync(SOCK, 0o600);
  } catch (e) {
    // chmod is best-effort; the socket still works without it.
  }
});
