package desktopsnapshot

import "syscall"

// platformErrnoNames are the Winsock codes Node names like their POSIX twins.
var platformErrnoNames = []errnoName{
	{syscall.Errno(10061), "ECONNREFUSED"}, // WSAECONNREFUSED
	{syscall.Errno(10054), "ECONNRESET"},   // WSAECONNRESET
	{syscall.Errno(10053), "ECONNABORTED"}, // WSAECONNABORTED
	{syscall.Errno(10060), "ETIMEDOUT"},    // WSAETIMEDOUT
	{syscall.Errno(10065), "EHOSTUNREACH"}, // WSAEHOSTUNREACH
	{syscall.Errno(10051), "ENETUNREACH"},  // WSAENETUNREACH
}
