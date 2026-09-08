#!/usr/bin/env python3
"""Minimal HA websocket client (stdlib only) -> run one or more WS commands."""
import base64, json, os, socket, struct, sys, hashlib

URL = os.environ["HA_URL"]; TOKEN = os.environ["HA_TOKEN"]
host = URL.split("//",1)[1]
h, _, p = host.partition(":"); port = int(p or 8123)

s = socket.create_connection((h, port), timeout=20)
key = base64.b64encode(os.urandom(16)).decode()
req = (f"GET /api/websocket HTTP/1.1\r\nHost: {h}:{port}\r\nUpgrade: websocket\r\n"
       f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n")
s.sendall(req.encode())
buf = b""
while b"\r\n\r\n" not in buf:
    buf += s.recv(4096)
hdr, rest = buf.split(b"\r\n\r\n", 1)
assert b"101" in hdr.split(b"\r\n")[0], hdr[:200]

pending = bytearray(rest)
def recv_exact(n):
    while len(pending) < n:
        d = s.recv(65536)
        if not d: raise EOFError
        pending.extend(d)
    out = bytes(pending[:n]); del pending[:n]; return out

def recv_msg():
    data = b""
    while True:
        b0, b1 = recv_exact(2)
        fin = b0 & 0x80; op = b0 & 0x0f
        ln = b1 & 0x7f
        if ln == 126: ln = struct.unpack(">H", recv_exact(2))[0]
        elif ln == 127: ln = struct.unpack(">Q", recv_exact(8))[0]
        payload = recv_exact(ln)
        if op == 8: raise EOFError("closed")
        data += payload
        if fin: break
    return json.loads(data.decode())

def send_msg(obj):
    payload = json.dumps(obj).encode()
    mask = os.urandom(4)
    ln = len(payload)
    frame = bytearray([0x81])
    if ln < 126: frame.append(0x80 | ln)
    elif ln < 65536: frame.append(0x80 | 126); frame += struct.pack(">H", ln)
    else: frame.append(0x80 | 127); frame += struct.pack(">Q", ln)
    frame += mask
    frame += bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    s.sendall(frame)

msg = recv_msg()
assert msg["type"] == "auth_required", msg
send_msg({"type": "auth", "access_token": TOKEN})
msg = recv_msg()
assert msg["type"] == "auth_ok", msg

cmds = json.loads(sys.argv[1])
out = {}
for i, c in enumerate(cmds, start=1):
    c = dict(c); c["id"] = i
    send_msg(c)
    while True:
        m = recv_msg()
        if m.get("id") == i and m.get("type") == "result":
            out[c["type"]] = m
            break
print(json.dumps(out, indent=2, default=str))
