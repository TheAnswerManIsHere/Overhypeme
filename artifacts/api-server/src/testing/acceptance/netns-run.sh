#!/usr/bin/env bash
# The acceptance run's network boundary (Launch Phase 2, increment 6, #631;
# plan D4). Runs as the first process inside a fresh network + mount namespace
# (`unshare -rnm`, or `sudo unshare -nm` where unprivileged user namespaces
# are restricted), so nothing it sets up touches the host.
#
#   netns-run.sh <workdir> <drop-to uid:gid or ""> <node> <api-root> -- <payload args...>
#
# - The only interface is loopback, with the default routes pointed at it, so
#   no packet can leave (containment).
# - DNS is made private to this mount namespace: a resolv.conf naming an
#   address the sink answers, and `hosts: files dns`, so no lookup takes a
#   host-side path such as systemd-resolved's unix socket.
# - NAT sends every DNS query, and every TCP connection or UDP datagram not
#   addressed to loopback, to the sink (observer 1).
# - The payload runs under strace, which records each outbound attempt whether
#   or not a packet followed (observer 2), and stays attached until the last
#   child exits.
#
# Writes <workdir>/sink.log, <workdir>/strace.log and <workdir>/netns.json.
# Any failure to build the boundary exits 90, an environment failure: the run
# never proceeds with less coverage than this describes.
#
# No exit leaves a sink behind (plan D5): a `fail` after the sink started, a
# normal return, and INT, TERM or HUP at any point all stop the sink, and a
# signal is forwarded to the payload's process group, then re-raised so the
# wrapper's own status is the signal's. The payload runs in the background
# under `wait` for that reason: a trap waits for a foreground command, so a
# signal sent during a long run would otherwise go unanswered until it ended.
set -uo pipefail

work="$1"; drop="$2"; node="$3"; api_root="$4"; shift 4
[ "${1:-}" = "--" ] && shift

TCP_PORT=40443
UDP_PORT=40053
# Tenths of a second to wait for the sink's ready file; a test shortens it.
SINK_READY_TENTHS="${NETNS_SINK_READY_TENTHS:-100}"
sink_pid=""
payload_pid=""

cleanup() {
  if [ -n "$payload_pid" ]; then
    for _ in $(seq 1 50); do kill -0 "$payload_pid" 2>/dev/null || break; sleep 0.1; done
    kill -KILL -- "-$payload_pid" 2>/dev/null
  fi
  if [ -n "$sink_pid" ]; then kill "$sink_pid" 2>/dev/null; wait "$sink_pid" 2>/dev/null; fi
}
on_signal() {
  trap - INT TERM HUP
  [ -n "$payload_pid" ] && kill -s "$1" -- "-$payload_pid" 2>/dev/null
  cleanup
  kill -s "$1" "$$"
  exit "$2"
}
trap 'on_signal INT 130' INT
trap 'on_signal TERM 143' TERM
trap 'on_signal HUP 129' HUP

fail() { printf '{"ok":false,"error":%s}\n' "\"$1\"" > "$work/netns.json"; echo "[netns] $1" >&2; cleanup; exit 90; }

for tool in ip iptables strace mount; do command -v "$tool" >/dev/null || fail "$tool is not installed"; done
ip link set lo up || fail "could not bring up loopback"
# Outbound traffic takes a non-loopback source address: a reply from the sink,
# translated back to the original destination, would otherwise arrive as a
# martian (a loopback source answering a public address) and be dropped, so
# a caller would hang until its own timeout instead of failing at once.
ip addr add 10.255.255.1/32 dev lo || fail "could not add the IPv4 source address"
ip route add default dev lo src 10.255.255.1 || fail "could not route IPv4 to loopback"
ipv6=no
if [ -d /proc/sys/net/ipv6 ] && ip -6 addr add fd00:acce::1/128 dev lo nodad 2>/dev/null \
   && ip -6 route add default dev lo src fd00:acce::1 2>/dev/null; then ipv6=yes; fi

printf 'nameserver 192.0.2.53\noptions timeout:1 attempts:1\n' > "$work/resolv.conf"
printf 'hosts: files dns\n' > "$work/nsswitch.conf"
mount --bind "$work/resolv.conf" /etc/resolv.conf || fail "could not replace resolv.conf in the mount namespace"
mount --bind "$work/nsswitch.conf" /etc/nsswitch.conf || fail "could not replace nsswitch.conf in the mount namespace"

iptables -t nat -A OUTPUT -p udp --dport 53 -j REDIRECT --to-ports "$UDP_PORT" || fail "iptables nat refused the DNS rule"
iptables -t nat -A OUTPUT ! -d 127.0.0.0/8 -p tcp -j REDIRECT --to-ports "$TCP_PORT" || fail "iptables nat refused the TCP rule"
iptables -t nat -A OUTPUT ! -d 127.0.0.0/8 -p udp -j REDIRECT --to-ports "$UDP_PORT" || fail "iptables nat refused the UDP rule"
if [ "$ipv6" = yes ]; then
  ip6tables -t nat -A OUTPUT -p udp --dport 53 -j REDIRECT --to-ports "$UDP_PORT" \
    && ip6tables -t nat -A OUTPUT ! -d ::1/128 -p tcp -j REDIRECT --to-ports "$TCP_PORT" \
    && ip6tables -t nat -A OUTPUT ! -d ::1/128 -p udp -j REDIRECT --to-ports "$UDP_PORT" \
    || fail "ip6tables nat refused a rule on a kernel with IPv6"
fi

cd "$api_root" || fail "no api-server directory"
"$node" --import tsx/esm src/testing/acceptance/sink.ts "$work/sink.log" "$TCP_PORT" "$UDP_PORT" "$work/sink.ready" "$( [ "$ipv6" = yes ] && echo ipv6 )" 2> "$work/sink.err" &
sink_pid=$!
for _ in $(seq 1 "$SINK_READY_TENTHS"); do [ -s "$work/sink.ready" ] && break; sleep 0.1; done
[ -s "$work/sink.ready" ] || fail "the sink did not start: $(tr -d '"\n' < "$work/sink.err" | cut -c1-200)"

privilege="user-namespace"
runner=()
if [ -n "$drop" ]; then
  privilege="sudo"
  runner=(setpriv --reuid="${drop%%:*}" --regid="${drop##*:}" --clear-groups --)
fi
printf '{"ok":true,"ipv6":%s,"privilege":"%s"}\n' "$( [ "$ipv6" = yes ] && echo true || echo false )" "$privilege" > "$work/netns.json"

# setsid gives the payload its own process group (a background child of this
# shell is not a group leader, so setsid does not fork and $! is that group).
setsid strace -f -ttt --seccomp-bpf -e trace=socket,connect,sendto,sendmsg,sendmmsg -o "$work/strace.log" -- "${runner[@]}" "$node" "$@" &
payload_pid=$!
wait "$payload_pid"
rc=$?
payload_pid=""
cleanup
exit "$rc"
