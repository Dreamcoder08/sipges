# syntax=docker/dockerfile:1
# The Go backend image for Cloudflare Containers (linux/amd64), docs/adr/0032 §4. Base images are
# pinned by digest, the same ones the hosting spike measured (spikes/go-container).
FROM --platform=linux/amd64 golang:1.27-alpine@sha256:b8c9b82affbbb82a020bbcf998dad2ba9516944ac7e883524642a481a9505e9c AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download && go mod verify
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags="-s -w -buildid=" -o /out/api ./cmd/api

# Not UPX-packed: it saves ~1 MB on the wire and adds ~220 ms to every cold start (spike README).
FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab AS runtime
COPY --from=build /out/api /api
USER nonroot:nonroot
ENV SIPGES_HOST=0.0.0.0 SIPGES_PORT=8080
EXPOSE 8080
ENTRYPOINT ["/api"]
