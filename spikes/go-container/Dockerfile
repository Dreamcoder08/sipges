# syntax=docker/dockerfile:1
# Minimal image for the ADR 0032 hosting spike. Cloudflare Containers run linux/amd64.
FROM --platform=linux/amd64 golang:1.27-alpine@sha256:b8c9b82affbbb82a020bbcf998dad2ba9516944ac7e883524642a481a9505e9c AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags="-s -w -buildid=" -o /out/spike ./cmd/spike

# Optional: UPX-compressed binary, used only to measure the trade-off (see README).
FROM build AS upx
RUN apk add --no-cache upx=5.2.0-r0 && upx --best --lzma -q /out/spike

FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab AS runtime-upx
COPY --from=upx /out/spike /spike
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/spike"]

# Default target: plain stripped binary.
FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab AS runtime
COPY --from=build /out/spike /spike
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/spike"]
