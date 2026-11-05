package application

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/domain"
)

// ErrUnreleasable is a payload holding a value the guard cannot read. TypeScript walks any plain
// object; a Go type can hide text (bytes, unexported fields), so it fails closed: nothing leaves.
var ErrUnreleasable = errors.New("privacy: payload cannot be sanitised")

var (
	timeType   = reflect.TypeFor[time.Time]()
	numberType = reflect.TypeFor[json.Number]()
)

// mapStrings sends every string leaf of src through fn into dst, a value of the same type. Map keys
// stay, as object keys do in mapStrings of egress-guard.ts; numbers, booleans and dates are kept.
func mapStrings(dst, src reflect.Value, fn func(string) string) error {
	if fields, ok := src.Interface().(domain.Fields); ok {
		dst.Set(reflect.ValueOf(fields.MapStrings(fn)))
		return nil
	}
	if src.Type() == timeType || src.Type() == numberType {
		dst.Set(src)
		return nil
	}
	switch src.Kind() {
	case reflect.String:
		dst.SetString(fn(src.String()))
	case reflect.Bool, reflect.Float32, reflect.Float64,
		reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		dst.Set(src)
	case reflect.Interface, reflect.Pointer:
		return mapIndirect(dst, src, fn)
	case reflect.Slice:
		return mapSlice(dst, src, fn)
	case reflect.Array:
		for i := range src.Len() {
			if err := mapStrings(dst.Index(i), src.Index(i), fn); err != nil {
				return err
			}
		}
	case reflect.Map:
		return mapMap(dst, src, fn)
	case reflect.Struct:
		return mapStruct(dst, src, fn)
	default:
		return fmt.Errorf("%w: %s", ErrUnreleasable, src.Type())
	}
	return nil
}

func mapIndirect(dst, src reflect.Value, fn func(string) string) error {
	if src.IsNil() {
		return nil
	}
	if src.Kind() == reflect.Pointer {
		dst.Set(reflect.New(src.Type().Elem()))
		return mapStrings(dst.Elem(), src.Elem(), fn)
	}
	inner := reflect.New(src.Elem().Type()).Elem()
	if err := mapStrings(inner, src.Elem(), fn); err != nil {
		return err
	}
	dst.Set(inner)
	return nil
}

func mapSlice(dst, src reflect.Value, fn func(string) string) error {
	if src.Type().Elem().Kind() == reflect.Uint8 {
		return fmt.Errorf("%w: %s", ErrUnreleasable, src.Type()) // bytes can hold anything
	}
	if src.IsNil() {
		return nil
	}
	dst.Set(reflect.MakeSlice(src.Type(), src.Len(), src.Len()))
	for i := range src.Len() {
		if err := mapStrings(dst.Index(i), src.Index(i), fn); err != nil {
			return err
		}
	}
	return nil
}

func mapMap(dst, src reflect.Value, fn func(string) string) error {
	if src.Type().Key().Kind() != reflect.String {
		return fmt.Errorf("%w: %s", ErrUnreleasable, src.Type())
	}
	if src.IsNil() {
		return nil
	}
	dst.Set(reflect.MakeMapWithSize(src.Type(), src.Len()))
	for iter := src.MapRange(); iter.Next(); {
		value := reflect.New(src.Type().Elem()).Elem()
		if err := mapStrings(value, iter.Value(), fn); err != nil {
			return err
		}
		dst.SetMapIndex(iter.Key(), value)
	}
	return nil
}

func mapStruct(dst, src reflect.Value, fn func(string) string) error {
	for i := range src.NumField() {
		if !src.Type().Field(i).IsExported() {
			return fmt.Errorf("%w: unexported field in %s", ErrUnreleasable, src.Type())
		}
		if err := mapStrings(dst.Field(i), src.Field(i), fn); err != nil {
			return err
		}
	}
	return nil
}

// mapValue is the sanitised copy of data.
func mapValue[T any](data T, fn func(string) string) (T, error) {
	var out T
	src := reflect.ValueOf(&data).Elem()
	dst := reflect.ValueOf(&out).Elem()
	err := mapStrings(dst, src, fn)
	return out, err
}

// stringChars counts the characters of every string leaf of data, as the access log reports them.
func stringChars[T any](data T) (int, error) {
	total := 0
	_, err := mapValue(data, func(text string) string {
		total += domain.CodePoints(text)
		return text
	})
	return total, err
}
