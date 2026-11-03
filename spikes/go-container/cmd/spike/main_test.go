package main

import (
	"testing"
)

func TestLoadConfig(t *testing.T) {
	tests := []struct {
		name        string
		env         map[string]string
		wantAddr    string
		wantTargets []string
		wantRegion  string
	}{
		{name: "defaults without secrets", env: map[string]string{}, wantAddr: ":8080"},
		{
			name:        "both urls and placement",
			env:         map[string]string{"PORT": "9000", "DATABASE_URL": "postgres://a", "DATABASE_URL_POOLED": "postgres://b", "CLOUDFLARE_REGION": "ENAM"},
			wantAddr:    ":9000",
			wantTargets: []string{"direct", "pooled"},
			wantRegion:  "ENAM",
		},
		{name: "direct only", env: map[string]string{"DATABASE_URL": "postgres://a"}, wantAddr: ":8080", wantTargets: []string{"direct"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := loadConfig(func(k string) string { return tt.env[k] })
			if cfg.addr != tt.wantAddr {
				t.Errorf("addr = %q, want %q", cfg.addr, tt.wantAddr)
			}
			if len(cfg.targets) != len(tt.wantTargets) {
				t.Fatalf("targets = %v, want %v", cfg.targets, tt.wantTargets)
			}
			for _, name := range tt.wantTargets {
				if _, ok := cfg.targets[name]; !ok {
					t.Errorf("missing target %q", name)
				}
			}
			if cfg.placement.Region != tt.wantRegion {
				t.Errorf("region = %q, want %q", cfg.placement.Region, tt.wantRegion)
			}
		})
	}
}
