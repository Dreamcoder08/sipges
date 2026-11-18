package localpg

import (
	"errors"
	"fmt"
)

// The kinds of failure. Their text is English, for logs; UserMessage gives the Spanish sentence
// the desktop shows to the person in front of it.
var (
	// ErrBinariesMissing is a binaries folder without initdb, pg_ctl or postgres.
	ErrBinariesMissing = errors.New("localpg: PostgreSQL binaries not found")
	// ErrWrongBinaries is a postgres that is not major version 18.
	ErrWrongBinaries = errors.New("localpg: the binaries are not PostgreSQL 18")
	// ErrForeignDataDir is a non-empty data folder that is not a PostgreSQL 18 cluster. It is never
	// written: it may hold someone's data.
	ErrForeignDataDir = errors.New("localpg: data folder is not empty and is not a PostgreSQL 18 data folder")
	// ErrInit is initdb failing on an empty folder.
	ErrInit = errors.New("localpg: initdb failed")
	// ErrStart is the server not accepting connections within the timeout.
	ErrStart = errors.New("localpg: the server did not start")
	// ErrStop is the server not stopping within the timeout.
	ErrStop = errors.New("localpg: the server did not stop")
)

// Error carries one kind above, the path it concerns and the underlying cause.
type Error struct {
	Kind error
	// Path is the folder or file concerned: the binaries, the data folder or the log.
	Path string
	Err  error
}

func (e *Error) Error() string {
	msg := fmt.Sprintf("%v (%s)", e.Kind, e.Path)
	if e.Err != nil {
		msg += ": " + e.Err.Error()
	}
	return msg
}

// Is matches the kind, so errors.Is(err, ErrForeignDataDir) works.
func (e *Error) Is(target error) bool { return target == e.Kind }

// Unwrap returns the cause.
func (e *Error) Unwrap() error { return e.Err }

// UserMessage is the Spanish sentence for the screen; a cause it does not know gets a general one.
func UserMessage(err error) string {
	var e *Error
	path := ""
	if errors.As(err, &e) {
		path = e.Path
	}
	switch {
	case errors.Is(err, ErrBinariesMissing):
		return "No se encontraron los ejecutables de PostgreSQL en " + path + ". Vuelva a instalar SIPGES."
	case errors.Is(err, ErrWrongBinaries):
		return "Los ejecutables de PostgreSQL en " + path + " no son la versión 18. Vuelva a instalar SIPGES."
	case errors.Is(err, ErrForeignDataDir):
		return "La carpeta " + path + " tiene archivos pero no es una base de datos de SIPGES; no se tocó. " +
			"Muévala a otro lugar o pida ayuda."
	case errors.Is(err, ErrInit):
		return "No se pudo crear la base de datos local. Revise el registro en " + path + "."
	case errors.Is(err, ErrStart):
		return "No se pudo iniciar la base de datos local. Revise el registro en " + path + "."
	case errors.Is(err, ErrStop):
		return "La base de datos local no se detuvo a tiempo. Revise el registro en " + path + "."
	}
	return "La base de datos local falló. Revise el registro de SIPGES."
}
