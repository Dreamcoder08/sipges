package application_test

import (
	"context"
	"errors"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/documents/application"
	tenancy "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
)

type emptyReviews struct{}

func (emptyReviews) List(context.Context, string, application.ReviewQuery) (application.ReviewPage, error) {
	return application.ReviewPage{}, nil
}

func TestListReviewNeedsTheRecordsLookup(t *testing.T) {
	scope := tenancy.Scope{CompanyID: "SIPGES", ProjectID: "PRJ-SECHURA"}
	_, err := application.Service{Store: emptyReviews{}}.ListReview(context.Background(), scope, nil, nil, 10, 0)
	if !errors.Is(err, application.ErrNoRecordLookup) {
		t.Fatalf("got %v, want ErrNoRecordLookup", err)
	}
}
