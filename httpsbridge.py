import os
import socket
import threading
import time

LISTEN_HOST = '127.0.0.1'
LISTEN_PORT = int(os.environ.get('BRIDGE_PORT', '8899'))
SOCKS_HOST = '127.0.0.1'
SOCKS_PORT = int(os.environ.get('SOCKS_PORT', '10808'))
LOG = 'logs/bridge.log'


def log(msg):
    try:
        with open(LOG, 'a', encoding='utf-8') as f:
            f.write('%s %s\n' % (time.strftime('%Y-%m-%d %H:%M:%S'), msg))
    except Exception:
        pass


def recv_exact(sock, n):
    buf = b''
    while len(buf) < n:
        d = sock.recv(n - len(buf))
        if not d:
            raise OSError('eof')
        buf += d
    return buf


def socks_connect(host, port, timeout=25):
    s = socket.create_connection((SOCKS_HOST, SOCKS_PORT), timeout=timeout)
    s.settimeout(timeout)
    s.sendall(b'\x05\x01\x00')
    if recv_exact(s, 2) != b'\x05\x00':
        raise OSError('socks hello failed')
    hb = host.encode('idna')
    req = b'\x05\x01\x00\x03' + bytes([len(hb)]) + hb + port.to_bytes(2, 'big')
    s.sendall(req)
    head = recv_exact(s, 4)
    if head[1] != 0:
        raise OSError('socks connect failed code=%d' % head[1])
    atyp = head[3]
    if atyp == 1:
        recv_exact(s, 6)
    elif atyp == 3:
        n = recv_exact(s, 1)[0]
        recv_exact(s, n + 2)
    elif atyp == 4:
        recv_exact(s, 18)
    s.settimeout(None)
    return s


def relay(src, dst):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except Exception:
        pass
    finally:
        try:
            dst.shutdown(socket.SHUT_WR)
        except Exception:
            pass


def read_head(conn):
    buf = b''
    conn.settimeout(30)
    while b'\r\n\r\n' not in buf:
        d = conn.recv(65536)
        if not d:
            return None, b''
        buf += d
        if len(buf) > 65536:
            break
    head, _, rest = buf.partition(b'\r\n\r\n')
    return head, rest


def handle(conn, addr):
    try:
        head, rest = read_head(conn)
        if head is None:
            return
        lines = head.split(b'\r\n')
        parts = lines[0].decode('latin1', 'replace').split(' ')
        if len(parts) < 3:
            return
        method, target = parts[0], parts[1]
        if method.upper() == 'CONNECT':
            host, port_s = target.rsplit(':', 1) if ':' in target else (target, '443')
            port = int(port_s)
            upstream = socks_connect(host, port)
            conn.sendall(b'HTTP/1.1 200 Connection Established\r\n\r\n')
            if rest:
                upstream.sendall(rest)
            t = threading.Thread(target=relay, args=(conn, upstream), daemon=True)
            t.start()
            relay(upstream, conn)
            log('CONNECT %s:%d done' % (host, port))
        else:
            host = None
            port = 80
            for ln in lines[1:]:
                if ln.lower().startswith(b'host:'):
                    hv = ln.split(b':', 1)[1].strip().decode('latin1')
                    if ':' in hv:
                        host, ps = hv.rsplit(':', 1)
                        port = int(ps)
                    else:
                        host = hv
                    break
            if not host:
                conn.sendall(b'HTTP/1.1 400 Bad Request\r\n\r\n')
                return
            upstream = socks_connect(host, port)
            upstream.sendall(head + b'\r\n\r\n' + rest)
            t = threading.Thread(target=relay, args=(conn, upstream), daemon=True)
            t.start()
            relay(upstream, conn)
            log('HTTP %s:%d done' % (host, port))
    except Exception as e:
        log('ERR %r %s' % (addr, e))
        try:
            conn.sendall(b'HTTP/1.1 502 Bad Gateway\r\n\r\n')
        except Exception:
            pass
    finally:
        try:
            conn.close()
        except Exception:
            pass


def main():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind((LISTEN_HOST, LISTEN_PORT))
    s.listen(128)
    log('listening %s:%d -> socks %s:%d' % (LISTEN_HOST, LISTEN_PORT, SOCKS_HOST, SOCKS_PORT))
    while True:
        try:
            c, a = s.accept()
            threading.Thread(target=handle, args=(c, a), daemon=True).start()
        except Exception as e:
            log('ACCEPT_ERR %r' % (e,))


if __name__ == '__main__':
    main()
