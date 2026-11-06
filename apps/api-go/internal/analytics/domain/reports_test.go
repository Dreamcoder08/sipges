package domain_test

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analytics/domain"
)

type recordedReports struct {
	Records map[string][]struct {
		ID      string          `json:"id"`
		Payload json.RawMessage `json:"payload"`
	} `json:"records"`
	Situational json.RawMessage `json:"situational"`
	Strategic   json.RawMessage `json:"strategic"`
	Integrated  json.RawMessage `json:"integrated"`
	Consensus   json.RawMessage `json:"consensus"`
	Reports     map[string][]struct {
		Kind  string `json:"kind"`
		Level int    `json:"level"`
		Text  string `json:"text"`
	} `json:"reports"`
}

func TestReportOutlinesMatchTheTypeScriptOnes(t *testing.T) {
	raw, err := os.ReadFile("testdata/reports.json")
	if err != nil {
		t.Fatal(err)
	}
	var recorded map[string]recordedReports
	if err := json.Unmarshal(raw, &recorded); err != nil {
		t.Fatal(err)
	}
	for name, c := range recorded {
		var records domain.RecordsByModule
		for module, rows := range c.Records {
			m := domain.ModuleRecords{Module: module}
			for _, row := range rows {
				m.Records = append(m.Records, domain.StoredRecord{ID: row.ID, Payload: row.Payload})
			}
			records = append(records, m)
		}
		builders := map[string]func() ([]domain.ReportBlock, error){
			"situational": func() ([]domain.ReportBlock, error) { return domain.SituationalReport(c.Situational) },
			"integrated":  func() ([]domain.ReportBlock, error) { return domain.IntegratedReport(c.Integrated) },
			"consensus":   func() ([]domain.ReportBlock, error) { return domain.ConsensusReport(c.Consensus) },
			"strategic": func() ([]domain.ReportBlock, error) {
				return domain.StrategicReport(records, c.Strategic, c.Situational)
			},
		}
		for report, build := range builders {
			t.Run(name+"/"+report, func(t *testing.T) {
				got, err := build()
				if err != nil {
					t.Fatal(err)
				}
				want := c.Reports[report]
				if len(got) != len(want) {
					t.Fatalf("%d blocks, want %d", len(got), len(want))
				}
				for i := range want {
					w := domain.ReportBlock{Kind: domain.BlockKind(want[i].Kind), Level: want[i].Level, Text: want[i].Text}
					if !reflect.DeepEqual(got[i], w) {
						t.Fatalf("block %d\ngot  %+v\nwant %+v", i, got[i], w)
					}
				}
			})
		}
	}
}
