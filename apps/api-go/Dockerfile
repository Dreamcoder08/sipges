# syntax=docker/dockerfile:1
# The Go backend image for Cloudflare Containers (linux/amd64), docs/adr/0032 §4. Base images are
# pinned by digest; the Go version matches the CI pin in .github/workflows/go.yml. The build context
# is the repository root (`docker build -f apps/api-go/Dockerfile .`), because the module replaces
# engines/go with its local copy; Dockerfile.dockerignore sends only those two directories.
FROM --platform=linux/amd64 golang:1.27.4-alpine@sha256:0a5f7fe796599ff487605987432e7619ae45beeb2fba4c2ce0b907879932aebf AS build
WORKDIR /src/apps/api-go
COPY engines/go /src/engines/go
COPY apps/api-go/go.mod apps/api-go/go.sum ./
RUN go mod download && go mod verify
COPY apps/api-go/cmd ./cmd
COPY apps/api-go/internal ./internal
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags="-s -w -buildid=" -o /out/api ./cmd/api

# Not UPX-packed: it saves ~1 MB on the wire and adds ~220 ms to every cold start (spike README).
FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab AS runtime
COPY --from=build /out/api /api
USER nonroot:nonroot
# Go does not read the container's memory limit. WebAssembly linear memory lives on the Go heap,
# so this limit covers it too; the rest of the 1 GiB `basic` instance is for compiled code and stacks.
ENV SIPGES_HOST=0.0.0.0 SIPGES_PORT=8080 GOMEMLIMIT=800MiB
EXPOSE 8080
ENTRYPOINT ["/api"]
