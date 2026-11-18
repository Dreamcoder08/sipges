package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// The database passwords live next to the launcher's secrets, created once and never rewritten:
// the cluster keeps the superuser's from initdb, and provision sets the API login's on each start.
const (
	superPasswordFile = "pg18-superuser-password" //nolint:gosec // G101: a file name, not a credential
	appPasswordFile   = "pg18-app-password"       //nolint:gosec // G101: a file name, not a credential
)

type secrets struct {
	dataKey       string
	adminPassword string
	pgSuper       string
	pgApp         string
}

// readSecrets reads data-key and admin-password, which the launcher creates (deploy/desktop),
// trimmed as the launcher's $(cat …) trims them, and creates the database passwords when missing.
func readSecrets(state string) (secrets, error) {
	var sec secrets
	var err error
	if sec.dataKey, err = readSecret(state, "data-key"); err != nil {
		return secrets{}, err
	}
	if sec.adminPassword, err = readSecret(state, "admin-password"); err != nil {
		return secrets{}, err
	}
	if sec.pgSuper, err = ensureSecret(state, superPasswordFile); err != nil {
		return secrets{}, err
	}
	if sec.pgApp, err = ensureSecret(state, appPasswordFile); err != nil {
		return secrets{}, err
	}
	return sec, nil
}

func readSecret(state, name string) (string, error) {
	body, err := os.ReadFile(filepath.Join(state, name)) //nolint:gosec // G304: the state folder the user runs SIPGES from
	if err == nil && strings.TrimSpace(string(body)) != "" {
		return strings.TrimSpace(string(body)), nil
	}
	if err == nil {
		err = errors.New("blank")
	}
	return "", &userError{
		msg: "Falta el archivo " + name + " en la carpeta de datos de SIPGES (" + state + "). Abra SIPGES desde su acceso directo.",
		err: fmt.Errorf("read %s: %w", name, err),
	}
}

// ensureSecret returns the secret in name, creating a random one only this user may read when the
// file is missing or blank.
func ensureSecret(state, name string) (string, error) {
	path := filepath.Join(state, name)
	if body, err := os.ReadFile(path); err == nil { //nolint:gosec // G304: the state folder the user runs SIPGES from
		if v := strings.TrimSpace(string(body)); v != "" {
			return v, nil
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", secretError(name, err)
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", secretError(name, err)
	}
	value := hex.EncodeToString(raw)
	if err := os.WriteFile(path, []byte(value+"\n"), 0o600); err != nil {
		return "", secretError(name, err)
	}
	return value, nil
}

func secretError(name string, err error) error {
	return &userError{msg: "No se pudo guardar una clave de SIPGES en la carpeta de datos.", err: fmt.Errorf("%s: %w", name, err)}
}
