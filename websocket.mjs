import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { EventEmitter } from "node:events";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE_BYTES = 128 * 1024 * 1024;

export async function createUnixWebSocketBridge({ socketPath, input, output }) {
  removeSocket(socketPath);
  fs.mkdirSync(path.dirname(socketPath), {
    recursive: true,
    mode: 0o700,
  });

  let active = null;
  const server = net.createServer((socket) => {
    if (active) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      return;
    }
    active = attachServerWebSocket(socket, { input, output });
    active.closed.finally(() => {
      if (active?.socket === socket) active = null;
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  fs.chmodSync(socketPath, 0o600);

  return {
    socketPath,
    async close() {
      active?.close();
      await new Promise((resolve) => server.close(() => resolve()));
      removeSocket(socketPath);
    },
  };
}

export async function connectUnixWebSocket(socketPath) {
  const socket = net.createConnection(socketPath);
  await once(socket, "connect");
  const key = crypto.randomBytes(16).toString("base64");
  socket.write(
    "GET /rpc HTTP/1.1\r\n" +
      "Host: localhost\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Key: ${key}\r\n` +
      "Sec-WebSocket-Version: 13\r\n\r\n",
  );

  let handshake = Buffer.alloc(0);
  let ready = false;
  const messages = new EventEmitter();
  const fail = (error) => {
    messages.emit("error", error);
    socket.destroy();
  };
  const parser = createFrameParser({
    expectMasked: false,
    onText: (text) => messages.emit("message", text),
    onPing: (payload) => socket.write(encodeFrame(0xA, payload, true)),
    onClose: () => messages.emit("close"),
  });

  socket.on("data", (chunk) => {
    try {
      if (ready) {
        parser.push(chunk);
        return;
      }
      handshake = Buffer.concat([handshake, chunk]);
      if (handshake.length > 64 * 1024) {
        fail(new Error("WebSocket handshake too large"));
        return;
      }
      const boundary = handshake.indexOf("\r\n\r\n");
      if (boundary === -1) return;
      const header = handshake.subarray(0, boundary + 4).toString("utf8");
      if (!/^HTTP\/1\.1 101\b/m.test(header)) {
        fail(new Error(`WebSocket upgrade failed: ${header.split("\r\n")[0]}`));
        return;
      }
      const expected = websocketAccept(key);
      const actual = header.match(/^Sec-WebSocket-Accept:\s*(.+)$/im)?.[1]?.trim();
      if (actual !== expected) {
        fail(new Error("WebSocket upgrade returned an invalid accept key"));
        return;
      }
      ready = true;
      messages.emit("open");
      const remainder = handshake.subarray(boundary + 4);
      handshake = Buffer.alloc(0);
      if (remainder.length) parser.push(remainder);
    } catch (error) {
      fail(error);
    }
  });
  socket.on("error", (error) => messages.emit("error", error));
  socket.on("close", () => messages.emit("close"));
  await once(messages, "open");

  return {
    onClose(listener) {
      messages.on("close", listener);
    },
    onMessage(listener) {
      messages.on("message", listener);
    },
    sendText(text) {
      socket.write(encodeFrame(0x1, Buffer.from(text), true));
    },
    close() {
      if (!socket.destroyed) socket.end(encodeFrame(0x8, Buffer.alloc(0), true));
    },
  };
}

function attachServerWebSocket(socket, { input, output }) {
  let handshake = Buffer.alloc(0);
  let ready = false;
  let outputBuffer = "";
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const parser = createFrameParser({
    expectMasked: true,
    onText(text) {
      if (!input.destroyed) input.write(`${text}\n`);
    },
    onPing(payload) {
      if (!socket.destroyed) socket.write(encodeFrame(0xA, payload, false));
    },
    onClose() {
      if (!socket.destroyed) socket.end(encodeFrame(0x8, Buffer.alloc(0), false));
    },
  });

  function onOutput(chunk) {
    outputBuffer += chunk.toString("utf8");
    let boundary;
    while ((boundary = outputBuffer.indexOf("\n")) !== -1) {
      const line = outputBuffer.slice(0, boundary);
      outputBuffer = outputBuffer.slice(boundary + 1);
      if (ready && line.trim() && !socket.destroyed) {
        socket.write(encodeFrame(0x1, Buffer.from(line), false));
      }
    }
  }

  output.on("data", onOutput);
  socket.on("data", (chunk) => {
    try {
      if (ready) {
        parser.push(chunk);
        return;
      }
      handshake = Buffer.concat([handshake, chunk]);
      const boundary = handshake.indexOf("\r\n\r\n");
      if (boundary === -1) {
        if (handshake.length > 64 * 1024) socket.destroy(new Error("WebSocket handshake too large"));
        return;
      }
      const header = handshake.subarray(0, boundary + 4).toString("utf8");
      const key = header.match(/^Sec-WebSocket-Key:\s*(.+)$/im)?.[1]?.trim();
      if (!/^GET\s+\/rpc\s+HTTP\/1\.1$/im.test(header.split("\r\n")[0]) || !key) {
        socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        return;
      }
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${websocketAccept(key)}\r\n\r\n`,
      );
      ready = true;
      const remainder = handshake.subarray(boundary + 4);
      handshake = Buffer.alloc(0);
      if (remainder.length) parser.push(remainder);
    } catch (error) {
      socket.destroy(error);
    }
  });

  function finish() {
    output.off("data", onOutput);
    resolveClosed();
  }
  socket.once("close", finish);
  socket.once("error", finish);

  return {
    socket,
    closed,
    close() {
      output.off("data", onOutput);
      if (!socket.destroyed) socket.destroy();
    },
  };
}

function createFrameParser({ expectMasked, onText, onPing, onClose }) {
  let buffer = Buffer.alloc(0);
  let fragments = [];
  let fragmentOpcode = null;

  return {
    push(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const first = buffer[0];
        const second = buffer[1];
        const fin = (first & 0x80) !== 0;
        const opcode = first & 0x0f;
        const masked = (second & 0x80) !== 0;
        if (masked !== expectMasked) throw new Error("Unexpected WebSocket masking mode");
        let length = second & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          const high = buffer.readUInt32BE(2);
          const low = buffer.readUInt32BE(6);
          if (high !== 0 || low > MAX_MESSAGE_BYTES) throw new Error("WebSocket message too large");
          length = low;
          offset = 10;
        }
        if (length > MAX_MESSAGE_BYTES) throw new Error("WebSocket message too large");
        const maskOffset = offset;
        if (masked) offset += 4;
        if (buffer.length < offset + length) return;
        const mask = masked ? Buffer.from(buffer.subarray(maskOffset, maskOffset + 4)) : null;
        let payload = Buffer.from(buffer.subarray(offset, offset + length));
        buffer = buffer.subarray(offset + length);
        if (masked) {
          for (let index = 0; index < payload.length; index += 1) {
            payload[index] ^= mask[index % 4];
          }
        }

        if (opcode === 0x8) {
          onClose(payload);
          continue;
        }
        if (opcode === 0x9) {
          onPing(payload);
          continue;
        }
        if (opcode === 0xA) continue;
        if (opcode === 0x1 || opcode === 0x2) {
          fragments = [payload];
          fragmentOpcode = opcode;
        } else if (opcode === 0x0 && fragmentOpcode != null) {
          fragments.push(payload);
        } else {
          throw new Error(`Unsupported WebSocket opcode ${opcode}`);
        }
        if (fin) {
          const message = Buffer.concat(fragments);
          if (fragmentOpcode !== 0x1) throw new Error("Binary WebSocket messages are not supported");
          fragments = [];
          fragmentOpcode = null;
          onText(message.toString("utf8"));
        }
      }
    },
  };
}

function encodeFrame(opcode, payload, masked) {
  const length = payload.length;
  const extended = length < 126 ? 0 : length <= 0xffff ? 2 : 8;
  const maskLength = masked ? 4 : 0;
  const frame = Buffer.alloc(2 + extended + maskLength + length);
  frame[0] = 0x80 | opcode;
  if (length < 126) {
    frame[1] = (masked ? 0x80 : 0) | length;
  } else if (length <= 0xffff) {
    frame[1] = (masked ? 0x80 : 0) | 126;
    frame.writeUInt16BE(length, 2);
  } else {
    frame[1] = (masked ? 0x80 : 0) | 127;
    frame.writeUInt32BE(0, 2);
    frame.writeUInt32BE(length, 6);
  }
  const payloadOffset = 2 + extended + maskLength;
  if (!masked) {
    payload.copy(frame, payloadOffset);
    return frame;
  }
  const mask = crypto.randomBytes(4);
  mask.copy(frame, 2 + extended);
  for (let index = 0; index < length; index += 1) {
    frame[payloadOffset + index] = payload[index] ^ mask[index % 4];
  }
  return frame;
}

function websocketAccept(key) {
  return crypto.createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
}

function removeSocket(socketPath) {
  try {
    if (fs.lstatSync(socketPath).isSocket()) fs.unlinkSync(socketPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function once(emitter, event) {
  return new Promise((resolve, reject) => {
    const onEvent = (...args) => {
      cleanup();
      resolve(args);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      emitter.off(event, onEvent);
      emitter.off("error", onError);
    };
    emitter.once(event, onEvent);
    emitter.once("error", onError);
  });
}
