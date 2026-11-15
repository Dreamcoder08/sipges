package httpx

import (
	"cmp"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"path"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// SPACSP is SPA_CSP of spa.ts (ADR 0004, ADR 0006): bundled scripts and styles only, same-origin
// API calls, and the external tile and cadastre hosts the maps read.
const SPACSP = "default-src 'self'; script-src 'self'; style-src 'self'; " +
	"img-src 'self' data: blob: https://tile.openstreetmap.org https://tiles.maps.eox.at https://geocatmin.ingemmet.gob.pe; " +
	"font-src 'self'; " +
	"connect-src 'self' https://tile.openstreetmap.org https://tiles.maps.eox.at https://s3.amazonaws.com; " +
	"object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"

var (
	assetName  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
	cesiumPath = regexp.MustCompile(`^(Workers|ThirdParty|Assets)(/[A-Za-z0-9_][A-Za-z0-9._-]{0,127}){1,4}$`)

	// rootFiles is ROOT_FILES of spa.ts: the installable-app files, the tab icons and the crawler
	// rule (functional-10 T9). Every other path outside the shell and the built folders asks for
	// a session.
	rootFiles = map[string]string{
		"/manifest.webmanifest": "application/manifest+json",
		"/sw.js":                "text/javascript; charset=utf-8",
		"/icon.svg":             "image/svg+xml",
		"/favicon.ico":          "image/x-icon",
		"/favicon.svg":          "image/svg+xml",
		"/robots.txt":           "text/plain; charset=utf-8",
	}
	assetTypes = map[string]string{
		".js":    "text/javascript; charset=utf-8",
		".css":   "text/css; charset=utf-8",
		".svg":   "image/svg+xml",
		".png":   "image/png",
		".woff2": "font/woff2",
		".json":  "application/json",
	}
	cesiumTypes = map[string]string{
		".js": assetTypes[".js"], ".css": assetTypes[".css"], ".svg": assetTypes[".svg"],
		".png": assetTypes[".png"], ".woff2": assetTypes[".woff2"], ".json": assetTypes[".json"],
		".jpg": "image/jpeg",
		".xml": "application/xml",
	}

	// compressible is COMPRESSIBLE of spa.ts: the asset types the build precompresses.
	compressible = map[string]bool{".js": true, ".css": true, ".svg": true, ".json": true}
	// variantSuffix names the file the web build writes for each content coding.
	variantSuffix = map[string]string{"br": ".br", "gzip": ".gz"}

	apiPrefixes = []string{"/api/", "/system/", "/auth/"}
	apiPaths    = map[string]bool{"/health": true, "/health/ready": true, "/select-project": true, "/logout": true}
)

func isClientRoute(p string) bool {
	if apiPaths[p] {
		return false
	}
	for _, prefix := range apiPrefixes {
		if strings.HasPrefix(p, prefix) {
			return false
		}
	}
	return true
}

// isSPARequest is isSpaRequest of spa.ts: built files, and the shell for a browser navigation to
// a client route. None of them needs a session or the database.
func isSPARequest(r *http.Request) bool {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return false
	}
	p := r.URL.Path
	if _, ok := rootFiles[p]; ok {
		return true
	}
	return strings.HasPrefix(p, "/assets/") || strings.HasPrefix(p, "/cesium/") ||
		(isClientRoute(p) && strings.Contains(r.Header.Get("Accept"), "text/html"))
}

// Web is spaMiddleware of spa.ts over the Vite build in dir, for a host without the Worker: it
// answers before authentication, because the shell and the bundle hold no tenant data. Files are
// opened through os.Root, so neither a name nor a link inside the build can leave it.
func Web(dir string) (Middleware, error) {
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, fmt.Errorf("web directory: %w", err)
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !isSPARequest(r) {
				next.ServeHTTP(w, r)
				return
			}
			p := r.URL.Path
			switch {
			case rootFiles[p] != "":
				w.Header().Set("Content-Security-Policy", SPACSP)
				serveBuilt(w, root, strings.TrimPrefix(p, "/"), rootFiles[p])
			case strings.HasPrefix(p, "/assets/"):
				name := strings.TrimPrefix(p, "/assets/")
				contentType := assetTypes[path.Ext(name)]
				if contentType == "" || !assetName.MatchString(name) {
					WriteError(w, http.StatusNotFound, "Not Found")
					return
				}
				serveAsset(w, r, root, name, contentType)
			case strings.HasPrefix(p, "/cesium/"):
				file := strings.TrimPrefix(p, "/cesium/")
				contentType := cesiumTypes[path.Ext(file)]
				if contentType == "" || !cesiumPath.MatchString(file) {
					WriteError(w, http.StatusNotFound, "Not Found")
					return
				}
				w.Header().Set("Cache-Control", CesiumCache)
				w.Header().Set("Content-Security-Policy", SPACSP)
				serveBuilt(w, root, "cesium/"+file, contentType)
			default:
				serveShell(w, r, next, root)
			}
		})
	}, nil
}

// acceptedEncodings is acceptedEncodings of spa.ts: the precompressed codings an Accept-Encoding
// header allows, best first. A coding listed with q=0 is refused, "*" stands for the ones not
// listed, and brotli wins a tie (RFC 9110 §12.5.3).
func acceptedEncodings(header string) []string {
	weights := map[string]float64{}
	for part := range strings.SplitSeq(strings.ToLower(header), ",") {
		pieces := strings.Split(part, ";")
		coding := strings.TrimSpace(pieces[0])
		if coding == "" {
			continue
		}
		weight := 1.0
		for _, param := range pieces[1:] {
			if q, ok := strings.CutPrefix(strings.TrimSpace(param), "q="); ok {
				parsed, err := strconv.ParseFloat(q, 64)
				if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
					parsed = 0
				}
				weight = parsed
				break
			}
		}
		if coding == "x-gzip" {
			coding = "gzip"
		}
		weights[coding] = weight
	}
	weightOf := func(coding string) float64 {
		if w, ok := weights[coding]; ok {
			return w
		}
		return weights["*"]
	}
	accepted := make([]string, 0, 2)
	for _, coding := range []string{"br", "gzip"} {
		if weightOf(coding) > 0 {
			accepted = append(accepted, coding)
		}
	}
	slices.SortStableFunc(accepted, func(a, b string) int { return cmp.Compare(weightOf(b), weightOf(a)) })
	return accepted
}

// serveAsset answers a hashed asset: the brotli or gzip variant the build wrote when the client
// takes it (functional-10 T9), the plain file otherwise, cached for a year either way.
func serveAsset(w http.ResponseWriter, r *http.Request, root *os.Root, name, contentType string) {
	negotiated := compressible[path.Ext(name)]
	if negotiated {
		for _, coding := range acceptedEncodings(r.Header.Get("Accept-Encoding")) {
			file, info, err := openRegular(root, "assets/"+name+variantSuffix[coding])
			if err != nil {
				continue
			}
			w.Header().Set("Cache-Control", AssetCache)
			w.Header().Set("Content-Encoding", coding)
			w.Header().Set("Vary", "Accept-Encoding")
			writeFile(w, file, info, contentType)
			_ = file.Close()
			return
		}
	}
	file, info, err := openRegular(root, "assets/"+name)
	if err != nil {
		WriteError(w, http.StatusNotFound, "Not Found")
		return
	}
	defer func() { _ = file.Close() }()
	w.Header().Set("Cache-Control", AssetCache)
	if negotiated {
		w.Header().Set("Vary", "Accept-Encoding")
	}
	writeFile(w, file, info, contentType)
}

// serveShell answers a navigation; without a build's shell the request goes on to the API, as
// spaMiddleware's next() does.
func serveShell(w http.ResponseWriter, r *http.Request, next http.Handler, root *os.Root) {
	file, info, err := openRegular(root, "index.html")
	if err != nil {
		next.ServeHTTP(w, r)
		return
	}
	defer func() { _ = file.Close() }()
	w.Header().Set("Content-Security-Policy", SPACSP)
	w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
	writeFile(w, file, info, "text/html; charset=UTF-8")
}

// serveBuilt answers one built file; a missing one is the JSON 404 without what a hit would carry.
func serveBuilt(w http.ResponseWriter, root *os.Root, name, contentType string) {
	file, info, err := openRegular(root, name)
	if err != nil {
		w.Header().Del("Cache-Control")
		w.Header().Del("Content-Security-Policy")
		WriteError(w, http.StatusNotFound, "Not Found")
		return
	}
	defer func() { _ = file.Close() }()
	writeFile(w, file, info, contentType)
}

func openRegular(root *os.Root, name string) (*os.File, os.FileInfo, error) {
	file, err := root.Open(name)
	if err != nil {
		return nil, nil, err
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, nil, err
	}
	if !info.Mode().IsRegular() {
		_ = file.Close()
		return nil, nil, errors.New("not a regular file")
	}
	return file, info, nil
}

func writeFile(w http.ResponseWriter, file *os.File, info os.FileInfo, contentType string) {
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, file)
}
