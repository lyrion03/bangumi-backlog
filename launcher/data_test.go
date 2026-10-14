package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

func cacheValues(owner int) map[string]string {
	records, _ := json.Marshal(map[string]any{"version": 1, "owner": owner, "items": map[string]any{"51": map[string]any{"status": "collect", "dirty": true, "markedAt": 1700000000000, "episodeMarks": map[string]any{"7": map[string]any{"type": 3, "markedAt": 100}}}}})
	return map[string]string{
		recordsKey:                 string(records),
		"bbm-series-cache-v5":      "{\"version\":1,\"records\":[{\"scope\":\"user-42\",\"id\":51,\"at\":100,\"hint\":true},{\"scope\":\"public\",\"id\":99,\"at\":101,\"hint\":false},{\"scope\":\"user-90\",\"id\":8,\"at\":99}]}",
		"bbm-radar-data-v1":        "[[\"user-42:registered\",{\"at\":100,\"data\":\"2012-01-01\"}],[\"user-90:registered\",{\"at\":100,\"data\":\"2015-01-01\"}]]",
		"bbm-episode-snapshots-v1": "[[\"42:51\",{\"at\":102,\"rows\":[]}],[\"90:51\",{\"at\":103,\"rows\":[]}]]",
	}
}
func sendData(d *localData, scope string, values map[string]string, key string) *httptest.ResponseRecorder {
	body, _ := json.Marshal(map[string]any{"version": 1, "scope": scope, "values": values})
	r := httptest.NewRequest("POST", "http://127.0.0.1:4173/__backlog/data", bytes.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Backlog-Key", key)
	w := httptest.NewRecorder()
	d.handle(w, r)
	return w
}
func readData(t *testing.T, d *localData, scope string) map[string]any {
	t.Helper()
	w := httptest.NewRecorder()
	d.handle(w, httptest.NewRequest("GET", "http://127.0.0.1:4173/__backlog/data?scope="+scope, nil))
	if w.Code != 200 {
		t.Fatalf("read: %d %s", w.Code, w.Body.String())
	}
	var value map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &value); err != nil {
		t.Fatal(err)
	}
	return value
}
func TestDiskRoundTripAndIsolation(t *testing.T) {
	dir := t.TempDir()
	d := newLocalData(dir)
	if len(readData(t, d, "")["values"].(map[string]any)) != 0 {
		t.Fatal("new data should be empty")
	}
	original := cacheValues(42)
	if w := sendData(d, "user-42", original, d.key); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	saved := readData(t, d, "")["values"].(map[string]any)
	if saved[recordsKey] != original[recordsKey] {
		t.Fatal("record timestamps and mixed episodes changed")
	}
	if strings.Contains(saved["bbm-series-cache-v5"].(string), "user-90") || strings.Contains(saved["bbm-radar-data-v1"].(string), "user-90") || strings.Contains(saved["bbm-episode-snapshots-v1"].(string), "90:") {
		t.Fatal("other account leaked")
	}
	if !strings.Contains(saved["bbm-series-cache-v5"].(string), "public") {
		t.Fatal("public series lost")
	}
	if len(readData(t, d, "user-90")["values"].(map[string]any)) != 0 {
		t.Fatal("unknown account restored")
	}
	d2 := newLocalData(dir)
	if d2.key == d.key {
		t.Fatal("restart must rotate write key")
	}
	if readData(t, d2, "")["values"].(map[string]any)[recordsKey] != original[recordsKey] {
		t.Fatal("restart lost data")
	}
	if w := sendData(d2, "user-90", cacheValues(90), d2.key); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if readData(t, d2, "")["scope"] != "user-90" {
		t.Fatal("latest account not selected")
	}
	if readData(t, d2, "user-42")["values"].(map[string]any)[recordsKey] != original[recordsKey] {
		t.Fatal("previous account lost")
	}
	// Saving an intentionally empty record is valid, and must survive another restart.
	empty := map[string]string{recordsKey: "{\"version\":1,\"owner\":42,\"items\":{}}"}
	if w := sendData(d2, "user-42", empty, d2.key); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if readData(t, newLocalData(dir), "")["values"].(map[string]any)[recordsKey] != empty[recordsKey] {
		t.Fatal("empty record not preserved")
	}
	files, _ := os.ReadDir(dir)
	if len(files) != 1 || files[0].Name() != "browser-cache.json" {
		t.Fatal("temporary files not cleaned")
	}
}
func TestDiskRejectsInvalidWrites(t *testing.T) {
	d := newLocalData(t.TempDir())
	for _, tc := range []struct {
		name, scope, key string
		values           map[string]string
		status           int
	}{
		{"missing key", "user-42", "", cacheValues(42), 403},
		{"mismatched account", "user-90", d.key, cacheValues(42), 400},
		{"path traversal", "../other", d.key, cacheValues(42), 400},
		{"no records", "user-42", d.key, map[string]string{}, 400},
		{"unknown key", "user-42", d.key, map[string]string{recordsKey: cacheValues(42)[recordsKey], "bbm-token": "\"secret\""}, 400},
		{"malformed cache", "user-42", d.key, map[string]string{recordsKey: cacheValues(42)[recordsKey], "bbm-radar-data-v1": "null"}, 400},
		{"malformed series", "user-42", d.key, map[string]string{recordsKey: cacheValues(42)[recordsKey], "bbm-series-cache-v5": "{\"version\":1}"}, 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := sendData(d, tc.scope, tc.values, tc.key)
			if w.Code != tc.status {
				t.Fatal(w.Code, w.Body.String())
			}
		})
	}
	if _, err := os.Stat(d.file); !os.IsNotExist(err) {
		t.Fatal("invalid input touched disk")
	}
}
func TestDiskCorruptionAndFailedWritePreserveData(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "browser-cache.json")
	original := []byte("incomplete previous file")
	if err := os.WriteFile(path, original, 0600); err != nil {
		t.Fatal(err)
	}
	d := newLocalData(dir)
	if w := sendData(d, "user-42", cacheValues(42), d.key); w.Code != 503 {
		t.Fatal(w.Code)
	}
	after, _ := os.ReadFile(path)
	if !bytes.Equal(after, original) {
		t.Fatal("corrupt original overwritten")
	}
	d = newLocalData(t.TempDir())
	if w := sendData(d, "user-42", cacheValues(42), d.key); w.Code != 200 {
		t.Fatal(w.Code)
	}
	old := d.file
	// An existing directory as the target forces atomic replacement to fail on Windows.
	d.file = filepath.Join(filepath.Dir(old), "blocked")
	if err := os.Mkdir(d.file, 0700); err != nil {
		t.Fatal(err)
	}
	if w := sendData(d, "user-90", cacheValues(90), d.key); w.Code != 503 {
		t.Fatal(w.Code)
	}
	if d.state.Active != "user-42" {
		t.Fatal("failed write changed in-memory snapshot")
	}
	reloaded := newLocalData(filepath.Dir(old))
	if reloaded.state.Active != "user-42" {
		t.Fatal("failed write destroyed disk snapshot")
	}
}
func TestDiskHTTPBoundary(t *testing.T) {
	d := newLocalData(t.TempDir())
	site := fstest.MapFS{"index.html": {Data: []byte("site")}}
	handler := newHandler(site, "127.0.0.1:4173", newProfileReader(), d)
	for _, tc := range []struct {
		host, origin, site, path string
		status                   int
	}{
		{"127.0.0.1:4173", "", "same-origin", "/__backlog/data", 200},
		{"127.0.0.1:4173", "https://elsewhere.test", "", "/__backlog/data", 403},
		{"127.0.0.1:4173", "", "cross-site", "/__backlog/data", 403},
		{"elsewhere.test:4173", "", "", "/__backlog/data", 403},
		{"127.0.0.1:4173", "", "", "/data/browser-cache.json", 404},
	} {
		r := httptest.NewRequest(http.MethodGet, "http://"+tc.host+tc.path, nil)
		r.Header.Set("Origin", tc.origin)
		r.Header.Set("Sec-Fetch-Site", tc.site)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != tc.status {
			t.Fatal(tc, w.Code)
		}
		if tc.status == 200 && w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("credentials must not be HTTP cached")
		}
	}
}
