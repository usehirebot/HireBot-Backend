import net from 'net';
import dns from 'dns';

/**
 * A `net.Socket` factory for `pg`'s `stream` config option.
 *
 * Node's default hostname resolution (getaddrinfo) can return only an IPv6
 * address for a host even when that specific IPv6 route is unreachable —
 * observed against Neon's pooled endpoint on a network where IPv6 works
 * generally but doesn't route to that AWS range. `dns.resolve4()` bypasses
 * getaddrinfo and queries DNS directly for A records, so it isn't subject to
 * that filtering. Falls back to default resolution (the original host) for
 * anything `resolve4` can't handle — a literal IP, `localhost`, a name with
 * no A record — so local Postgres in dev is unaffected.
 *
 * `pg` calls this factory once per connection and uses the returned socket
 * for the raw TCP stream; the hostname pg uses for TLS SNI afterwards is
 * unaffected since that comes from the original connection string, not from
 * whatever address this socket actually dials.
 */
export function ipv4PreferringStream(): net.Socket {
  const socket = new net.Socket();
  const originalConnect = socket.connect.bind(socket);

  (socket as unknown as { connect: (port: number, host: string) => net.Socket }).connect = (port, host) => {
    dns.resolve4(host, (err, addresses) => {
      originalConnect(port, !err && addresses.length > 0 ? addresses[0] : host);
    });
    return socket;
  };

  return socket;
}
