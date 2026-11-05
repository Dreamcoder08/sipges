package secrets

import (
	"encoding/base64"
	"fmt"
	"regexp"
)

// Lookup reads one environment variable; os.LookupEnv satisfies it.
type Lookup func(key string) (string, bool)

var base64Text = regexp.MustCompile(`^[A-Za-z0-9+/]+={0,2}$`)

// DataKeys reads SIPGES_DATA_KEY and SIPGES_DATA_KEY_PREVIOUS as decodeDataKey of
// apps/api/src/platform/config.ts does (base64, 32 bytes). configured is false when
// SIPGES_DATA_KEY is unset; an invalid value of either is an error.
func DataKeys(lookup Lookup) (key, previous []byte, configured bool, err error) {
	raw, ok := lookup("SIPGES_DATA_KEY")
	if !ok {
		return nil, nil, false, nil
	}
	if key, err = decode("SIPGES_DATA_KEY", raw); err != nil {
		return nil, nil, false, err
	}
	if raw, ok := lookup("SIPGES_DATA_KEY_PREVIOUS"); ok {
		if previous, err = decode("SIPGES_DATA_KEY_PREVIOUS", raw); err != nil {
			return nil, nil, false, err
		}
	}
	return key, previous, true, nil
}

// decode accepts what Buffer.from(value, 'base64') decodes to 32 bytes behind the regular
// expression of config.ts; Node ignores missing padding and stray bits, so does this.
func decode(name, value string) ([]byte, error) {
	if !base64Text.MatchString(value) {
		return nil, fmt.Errorf("%s must decode to 32 bytes", name)
	}
	trimmed := value
	for len(trimmed) > 0 && trimmed[len(trimmed)-1] == '=' {
		trimmed = trimmed[:len(trimmed)-1]
	}
	key, err := base64.RawStdEncoding.Strict().DecodeString(trimmed)
	if err != nil {
		key, err = base64.RawStdEncoding.DecodeString(trimmed)
	}
	if err != nil || len(key) != 32 {
		return nil, fmt.Errorf("%s must decode to 32 bytes", name)
	}
	return key, nil
}
