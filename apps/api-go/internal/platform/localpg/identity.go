package localpg

// identity is what the operating system proves about the process a postmaster.pid names.
type identity int

const (
	identityUnknown  identity = iota // the system does not tell
	identityPostgres                 // PostgreSQL on this data folder
	identityOther                    // provably another program, or PostgreSQL on another folder
)

// processIdentity is identify; tests replace it to stand for a system that does not tell.
var processIdentity = identify
