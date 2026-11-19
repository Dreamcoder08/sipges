package pglitewasm

import (
	"context"
	"encoding/binary"
	"net/netip"
	"strconv"
)

// getaddrinfo resolves numeric addresses (and localhost) only, as needed by
// pg_hba.conf parsing; the backend never opens a real socket.
func (b *Backend) getaddrinfo(ctx context.Context, s []uint64) {
	node, service, hint, out := u32(s[0]), u32(s[1]), u32(s[2]), u32(s[3])
	var flags, family, typ, proto int32
	if hint != 0 {
		read := func(off uint32) int32 { v, _ := b.mem.ReadUint32Le(hint + off); return s32(v) }
		flags, family, typ, proto = read(0), read(4), read(8), read(12)
	}
	if typ != 0 && proto == 0 {
		proto = 6
		if typ == 2 {
			proto = 17
		}
	}
	if typ == 0 && proto != 0 {
		typ = 1
		if proto == 17 {
			typ = 2
		}
	}
	if proto == 0 {
		proto = 6
	}
	if typ == 0 {
		typ = 1
	}
	if node == 0 && service == 0 {
		s[0] = ret(-2)
		return
	}
	var port uint16
	if service != 0 {
		p, err := strconv.ParseUint(b.cstr(service), 10, 16)
		if err != nil {
			s[0] = ret(-8)
			return
		}
		port = uint16(p)
	}
	addr := netip.AddrFrom4([4]byte{127, 0, 0, 1})
	if node != 0 {
		name := b.cstr(node)
		if name != "localhost" {
			a, err := netip.ParseAddr(name)
			if err != nil {
				s[0] = ret(-2) // EAI_NONAME: no DNS here
				return
			}
			addr = a
		}
	} else if flags&1 != 0 {
		addr = netip.IPv4Unspecified()
	}
	if family == 10 && addr.Is4() {
		addr = netip.AddrFrom16(addr.As16())
	}
	if family == 2 && !addr.Is4() {
		s[0] = ret(-2)
		return
	}
	var sa []byte
	if addr.Is4() {
		family = 2
		sa = make([]byte, 16)
		binary.LittleEndian.PutUint16(sa, 2)
		a := addr.As4()
		copy(sa[4:], a[:])
	} else {
		family = 10
		sa = make([]byte, 28)
		binary.LittleEndian.PutUint16(sa, 10)
		a := addr.As16()
		copy(sa[8:], a[:])
	}
	binary.BigEndian.PutUint16(sa[2:], port)
	saPtr := u32(b.mustCall(ctx, "malloc", n64(len(sa))))
	aiPtr := u32(b.mustCall(ctx, "malloc", 32))
	b.mem.Write(saPtr, sa)
	ai := make([]byte, 32)
	binary.LittleEndian.PutUint32(ai[4:], w32(family))
	binary.LittleEndian.PutUint32(ai[8:], w32(typ))
	binary.LittleEndian.PutUint32(ai[12:], w32(proto))
	binary.LittleEndian.PutUint32(ai[16:], n32(len(sa)))
	binary.LittleEndian.PutUint32(ai[20:], saPtr)
	b.mem.Write(aiPtr, ai)
	b.mem.WriteUint32Le(out, aiPtr)
	s[0] = 0
}

// getnameinfo formats a sockaddr numerically.
func (b *Backend) getnameinfo(_ context.Context, s []uint64) {
	sa, salen := u32(s[0]), u32(s[1])
	node, nodelen, serv, servlen := u32(s[2]), int(u32(s[3])), u32(s[4]), int(u32(s[5]))
	raw, ok := b.mem.Read(sa, salen)
	if !ok || len(raw) < 16 {
		s[0] = ret(-6)
		return
	}
	var addr netip.Addr
	switch binary.LittleEndian.Uint16(raw) {
	case 2:
		addr = netip.AddrFrom4([4]byte(raw[4:8]))
	case 10:
		if len(raw) < 28 {
			s[0] = ret(-6)
			return
		}
		addr = netip.AddrFrom16([16]byte(raw[8:24]))
	default:
		s[0] = ret(-6)
		return
	}
	port := strconv.Itoa(int(binary.BigEndian.Uint16(raw[2:])))
	if node != 0 && nodelen > 0 {
		if len(addr.String())+1 > nodelen {
			s[0] = ret(-12)
			return
		}
		b.putCString(node, addr.String(), nodelen)
	}
	if serv != 0 && servlen > 0 {
		if len(port)+1 > servlen {
			s[0] = ret(-12)
			return
		}
		b.putCString(serv, port, servlen)
	}
	s[0] = 0
}
