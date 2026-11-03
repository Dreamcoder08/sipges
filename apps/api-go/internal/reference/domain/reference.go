package domain

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
)

// Scope is the company/project pair a request was resolved to.
type Scope struct {
	CompanyID string
	ProjectID string
}

// IsRegisteredScope is isRegisteredReferenceScope: the trusted repository references belong to
// one tenant and are never a fallback for another.
func IsRegisteredScope(s Scope) bool {
	return s.CompanyID == "SIPGES" && s.ProjectID == "PRJ-SECHURA"
}

// ProjectCoordinates is the ProjectCoordinates contract, fields in the contract's order.
type ProjectCoordinates struct {
	ProjectID         string        `json:"project_id"`
	ProjectName       string        `json:"project_name"`
	Initiative        string        `json:"initiative"`
	Description       string        `json:"description"`
	CRS               CRS           `json:"crs"`
	Source            Source        `json:"source"`
	NominalAreaSource NominalSource `json:"nominal_area_source"`
	Bbox              []float64     `json:"bbox"`
	Summary           Summary       `json:"summary"`
	Concessions       []Concession  `json:"concessions"`
}

// CRS names the coordinate reference systems; geometry is always EPSG:4326.
type CRS struct {
	Geometry           string `json:"geometry"`
	Label              string `json:"label"`
	ProjectedReference string `json:"projected_reference"`
	AxisOrder          string `json:"axis_order"`
}

// Source is where the geometry was consulted.
type Source struct {
	Organization string `json:"organization"`
	Service      string `json:"service"`
	Dataset      string `json:"dataset"`
	ConsultedOn  string `json:"consulted_on"`
	Scope        string `json:"scope"`
}

// NominalSource is where the nominal areas come from.
type NominalSource struct {
	Label string `json:"label"`
	Scope string `json:"scope"`
}

// Summary totals the concessions.
type Summary struct {
	ConcessionCount    float64 `json:"concession_count"`
	NominalAreaTotalHa float64 `json:"nominal_area_total_ha"`
	GISAreaTotalHa     float64 `json:"gis_area_total_ha"`
}

// Concession is one mining concession with its polygon.
type Concession struct {
	Code          string    `json:"code"`
	Name          string    `json:"name"`
	NominalAreaHa float64   `json:"nominal_area_ha"`
	GISAreaHa     float64   `json:"gis_area_ha"`
	Substance     string    `json:"substance"`
	Holder        string    `json:"holder"`
	Department    string    `json:"department"`
	Province      string    `json:"province"`
	District      string    `json:"district"`
	MiningZone    string    `json:"mining_zone"`
	Centroid      Centroid  `json:"centroid"`
	Bbox          []float64 `json:"bbox"`
	Geometry      Polygon   `json:"geometry"`
}

// Centroid is a concession's centre and how it was computed.
type Centroid struct {
	Longitude float64 `json:"longitude"`
	Latitude  float64 `json:"latitude"`
	Method    string  `json:"method"`
}

// Polygon is a GeoJSON polygon: at least one ring of at least four [longitude, latitude] points.
type Polygon struct {
	Type        string        `json:"type"`
	Coordinates [][][]float64 `json:"coordinates"`
}

// CanonicalEntity is one canonical name of the CanonicalEntities record.
type CanonicalEntity struct {
	CanonicalName string `json:"canonical_name"`
	ShortName     string `json:"short_name"`
	EntityType    string `json:"entity_type"`
	Territory     string `json:"territory"`
	Note          string `json:"note"`
}

// CanonicalEntities is the CanonicalEntities record, keyed by entity code.
type CanonicalEntities map[string]CanonicalEntity

// ParseProjectCoordinates is ProjectCoordinates.parse: every field is required and non-null,
// unknown fields are dropped, and the literal, tuple and minimum-length rules hold.
func ParseProjectCoordinates(raw []byte) (ProjectCoordinates, error) {
	var v ProjectCoordinates
	if err := parse(raw, &v); err != nil {
		return ProjectCoordinates{}, fmt.Errorf("project coordinates: %w", err)
	}
	if err := v.validate(); err != nil {
		return ProjectCoordinates{}, fmt.Errorf("project coordinates: %w", err)
	}
	return v, nil
}

// ParseCanonicalEntities is CanonicalEntities.parse.
func ParseCanonicalEntities(raw []byte) (CanonicalEntities, error) {
	v := CanonicalEntities{}
	if err := parse(raw, &v); err != nil {
		return nil, fmt.Errorf("canonical entities: %w", err)
	}
	return v, nil
}

func (p ProjectCoordinates) validate() error {
	if p.CRS.Geometry != "EPSG:4326" {
		return errors.New(`crs.geometry: expected "EPSG:4326"`)
	}
	if len(p.Bbox) != 4 {
		return errors.New("bbox: expected 4 numbers")
	}
	for i, c := range p.Concessions {
		if len(c.Bbox) != 4 {
			return fmt.Errorf("concessions.%d.bbox: expected 4 numbers", i)
		}
		if c.Geometry.Type != "Polygon" {
			return fmt.Errorf(`concessions.%d.geometry.type: expected "Polygon"`, i)
		}
		if len(c.Geometry.Coordinates) < 1 {
			return fmt.Errorf("concessions.%d.geometry.coordinates: expected at least 1 ring", i)
		}
		for j, ring := range c.Geometry.Coordinates {
			if len(ring) < 4 {
				return fmt.Errorf("concessions.%d.geometry.coordinates.%d: expected at least 4 points", i, j)
			}
			for k, point := range ring {
				if len(point) != 2 {
					return fmt.Errorf("concessions.%d.geometry.coordinates.%d.%d: expected 2 numbers", i, j, k)
				}
			}
		}
	}
	return nil
}

// parse decodes raw into v after checking that every field v declares is present and not null
// at every depth: encoding/json alone would leave a missing or null field at its zero value.
func parse(raw []byte, v any) error {
	if err := required(reflect.TypeOf(v).Elem(), raw, ""); err != nil {
		return err
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	if err := dec.Decode(v); err != nil {
		return err
	}
	if dec.More() {
		return errors.New("unexpected data after the document")
	}
	return nil
}

func required(t reflect.Type, raw json.RawMessage, path string) error {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return fmt.Errorf("%s: expected a value, got null", label(path))
	}
	switch t.Kind() {
	case reflect.Struct:
		var object map[string]json.RawMessage
		if err := json.Unmarshal(raw, &object); err != nil {
			return fmt.Errorf("%s: expected an object", label(path))
		}
		for i := range t.NumField() {
			field := t.Field(i)
			name, _, _ := strings.Cut(field.Tag.Get("json"), ",")
			value, ok := object[name]
			if !ok {
				return fmt.Errorf("%s: required", join(path, name))
			}
			if err := required(field.Type, value, join(path, name)); err != nil {
				return err
			}
		}
	case reflect.Slice:
		var items []json.RawMessage
		if err := json.Unmarshal(raw, &items); err != nil {
			return fmt.Errorf("%s: expected an array", label(path))
		}
		for i, item := range items {
			if err := required(t.Elem(), item, join(path, fmt.Sprint(i))); err != nil {
				return err
			}
		}
	case reflect.Map:
		var object map[string]json.RawMessage
		if err := json.Unmarshal(raw, &object); err != nil {
			return fmt.Errorf("%s: expected an object", label(path))
		}
		for key, value := range object {
			if err := required(t.Elem(), value, join(path, key)); err != nil {
				return err
			}
		}
	default:
		// Strings and numbers: encoding/json rejects a wrong type when it decodes.
	}
	return nil
}

func join(path, name string) string {
	if path == "" {
		return name
	}
	return path + "." + name
}

func label(path string) string {
	if path == "" {
		return "document"
	}
	return path
}
