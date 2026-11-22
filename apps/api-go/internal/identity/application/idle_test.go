package application

import (
	"context"
	"errors"
	"testing"
	"time"
)

type countingExtender struct {
	calls int
	to    time.Time
	err   error
}

func (e *countingExtender) ExtendSession(context.Context, string, SessionRenewal) (time.Time, bool, error) {
	e.calls++
	return e.to, !e.to.IsZero(), e.err
}

type plainTokens struct{}

func (plainTokens) NewToken() (string, error) { return "t", nil }
func (plainTokens) Hash(token string) string  { return "h:" + token }
func (plainTokens) PublicID(hash string) string {
	return "id:" + hash
}

var idleNow = time.Date(2026, 11, 22, 10, 0, 0, 0, time.UTC)

func activity(e *countingExtender) SessionActivity {
	return SessionActivity{Sessions: e, Tokens: plainTokens{}, Now: func() time.Time { return idleNow }}
}

func TestRecordSkipsTheDatabaseWhileTheSessionNeedsNoRenewal(t *testing.T) {
	e := &countingExtender{}
	remaining, err := activity(e).Record(t.Context(), "tok", idleNow.Add(58*time.Minute), true)
	if err != nil || remaining != 58*60 || e.calls != 0 {
		t.Fatalf("remaining=%d err=%v calls=%d, want 3480 and no write attempt", remaining, err, e.calls)
	}
}

func TestRecordRenewsOnceTheSessionNearsItsIdleLimit(t *testing.T) {
	e := &countingExtender{to: idleNow.Add(time.Hour)}
	remaining, err := activity(e).Record(t.Context(), "tok", idleNow.Add(10*time.Minute), true)
	if err != nil || remaining != 3600 || e.calls != 1 {
		t.Fatalf("remaining=%d err=%v calls=%d, want 3600 after one write", remaining, err, e.calls)
	}
}

func TestRecordReportsTheUnextendedRemainderWhenTheWriteFails(t *testing.T) {
	e := &countingExtender{err: errors.New("database unavailable")}
	remaining, err := activity(e).Record(t.Context(), "tok", idleNow.Add(10*time.Minute), true)
	if err == nil || remaining != 600 || e.calls != 1 {
		t.Fatalf("remaining=%d err=%v calls=%d, want 600 with the error", remaining, err, e.calls)
	}
}

func TestRecordNeverWritesForABackgroundRequest(t *testing.T) {
	e := &countingExtender{to: idleNow.Add(time.Hour)}
	remaining, _ := activity(e).Record(t.Context(), "tok", idleNow.Add(10*time.Minute), false)
	if remaining != 600 || e.calls != 0 {
		t.Fatalf("remaining=%d calls=%d", remaining, e.calls)
	}
}
