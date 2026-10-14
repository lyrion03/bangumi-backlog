package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

const recordsKey = "bangumi-batch-marker-v1"
const maxSnapshot = 24 << 20

var dataKeys = map[string]bool{recordsKey: true, "bbm-series-cache-v5": true, "bbm-radar-data-v1": true, "bbm-episode-snapshots-v1": true}
var scopePattern = regexp.MustCompile("^(local|user-[1-9][0-9]{0,15})$")

type diskProfile struct {
	Values    map[string]string `json:"values"`
	UpdatedAt int64             `json:"updatedAt"`
}
type diskFile struct {
	Version  int                    `json:"version"`
	Active   string                 `json:"active"`
	Profiles map[string]diskProfile `json:"profiles"`
}
type localData struct {
	mu        sync.Mutex
	file      string
	key       string
	state     diskFile
	loadError error
}

func newLocalData(directory string) *localData {
	secret := make([]byte, 32)
	_, err := rand.Read(secret)
	d := &localData{file: filepath.Join(directory, "browser-cache.json"), key: hex.EncodeToString(secret), state: diskFile{Version: 1, Profiles: map[string]diskProfile{}}}
	if err != nil {
		d.loadError = err
		return d
	}
	file, err := os.Open(d.file)
	if os.IsNotExist(err) {
		return d
	}
	if err != nil {
		d.loadError = err
		return d
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxSnapshot+1))
	if err != nil {
		d.loadError = err
		return d
	}
	var saved diskFile
	if len(data) > maxSnapshot || json.Unmarshal(data, &saved) != nil || saved.Version != 1 || saved.Profiles == nil {
		d.loadError = errors.New("invalid data file")
		return d
	}
	for scope, p := range saved.Profiles {
		cleaned, err := cleanValues(scope, p.Values)
		if err != nil {
			d.loadError = err
			return d
		}
		p.Values = cleaned
		saved.Profiles[scope] = p
	}
	if saved.Active != "" {
		if _, ok := saved.Profiles[saved.Active]; !ok {
			d.loadError = errors.New("missing active profile")
			return d
		}
	}
	d.state = saved
	return d
}
func recordScope(raw string) (string, error) {
	var state struct {
		Version int
		Owner   *int64
		Items   map[string]json.RawMessage
	}
	if json.Unmarshal([]byte(raw), &state) != nil || state.Version != 1 || state.Items == nil {
		return "", errors.New("invalid records")
	}
	if state.Owner == nil {
		return "local", nil
	}
	if *state.Owner <= 0 || *state.Owner > 9007199254740991 {
		return "", errors.New("invalid account")
	}
	value, _ := json.Marshal(*state.Owner)
	return "user-" + string(value), nil
}
func cleanValues(scope string, values map[string]string) (map[string]string, error) {
	if !scopePattern.MatchString(scope) {
		return nil, errors.New("invalid scope")
	}
	result := map[string]string{}
	for key, raw := range values {
		if !dataKeys[key] || !json.Valid([]byte(raw)) {
			return nil, errors.New("invalid storage key or JSON")
		}
		if key == recordsKey {
			owner, err := recordScope(raw)
			if err != nil || owner != scope {
				return nil, errors.New("account mismatch")
			}
			result[key] = raw
			continue
		}
		if key == "bbm-series-cache-v5" {
			var value struct {
				Version int
				Records []json.RawMessage
			}
			if json.Unmarshal([]byte(raw), &value) != nil || value.Version != 1 || value.Records == nil {
				return nil, errors.New("invalid series cache")
			}
			keep := []json.RawMessage{}
			for _, row := range value.Records {
				var entry struct{ Scope string }
				if json.Unmarshal(row, &entry) != nil {
					return nil, errors.New("invalid series entry")
				}
				if entry.Scope == scope || entry.Scope == "public" {
					keep = append(keep, row)
				}
			}
			encoded, _ := json.Marshal(map[string]any{"version": 1, "records": keep})
			result[key] = string(encoded)
			continue
		}
		var rows [][]json.RawMessage
		if json.Unmarshal([]byte(raw), &rows) != nil || rows == nil {
			return nil, errors.New("invalid cache")
		}
		keep := [][]json.RawMessage{}
		prefix := scope + ":"
		if key == "bbm-episode-snapshots-v1" {
			prefix = strings.TrimPrefix(scope, "user-") + ":"
		}
		for _, row := range rows {
			if len(row) != 2 {
				return nil, errors.New("invalid cache entry")
			}
			var id string
			if json.Unmarshal(row[0], &id) != nil {
				return nil, errors.New("invalid cache id")
			}
			if strings.HasPrefix(id, prefix) {
				keep = append(keep, row)
			}
		}
		encoded, _ := json.Marshal(keep)
		result[key] = string(encoded)
	}
	if _, ok := result[recordsKey]; !ok {
		return nil, errors.New("records required")
	}
	return result, nil
}
func (d *localData) handle(w http.ResponseWriter, r *http.Request) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.loadError != nil {
		writeJSON(w, 503, map[string]string{"error": "本地数据文件无法读取，已保留原文件；浏览器数据不受影响"})
		return
	}
	switch r.Method {
	case http.MethodGet:
		scope := r.URL.Query().Get("scope")
		if scope == "" {
			scope = d.state.Active
		}
		if scope != "" && !scopePattern.MatchString(scope) {
			writeJSON(w, 400, struct{}{})
			return
		}
		values := d.state.Profiles[scope].Values
		if values == nil {
			values = map[string]string{}
		}
		writeJSON(w, 200, map[string]any{"version": 1, "scope": scope, "values": values, "writeKey": d.key})
	case http.MethodPost:
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Backlog-Key")), []byte(d.key)) != 1 || !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
			writeJSON(w, 403, struct{}{})
			return
		}
		var body struct {
			Version int
			Scope   string
			Values  map[string]string
		}
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxSnapshot))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&body) != nil || body.Version != 1 || decoder.Decode(new(any)) != io.EOF {
			writeJSON(w, 400, struct{}{})
			return
		}
		values, err := cleanValues(body.Scope, body.Values)
		if err != nil {
			writeJSON(w, 400, map[string]string{"error": err.Error()})
			return
		}
		profiles := make(map[string]diskProfile, len(d.state.Profiles)+1)
		for k, v := range d.state.Profiles {
			profiles[k] = v
		}
		profiles[body.Scope] = diskProfile{values, time.Now().UnixMilli()}
		next := diskFile{Version: 1, Active: body.Scope, Profiles: profiles}
		data, err := json.Marshal(next)
		if err != nil || len(data) > maxSnapshot {
			writeJSON(w, 413, struct{}{})
			return
		}
		if err = atomicSave(d.file, data); err != nil {
			writeJSON(w, 503, map[string]string{"error": "无法写入 EXE 旁的 data 文件夹，请检查目录权限；浏览器记录已保留"})
			return
		}
		d.state = next
		writeJSON(w, 200, map[string]any{"savedAt": profiles[body.Scope].UpdatedAt})
	default:
		w.Header().Set("Allow", "GET, POST")
		http.Error(w, "Method not allowed", 405)
	}
}
func atomicSave(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	file, err := os.CreateTemp(dir, ".snapshot-*.tmp")
	if err != nil {
		return err
	}
	name := file.Name()
	defer os.Remove(name)
	if _, err = file.Write(data); err != nil {
		file.Close()
		return err
	}
	if err = file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	return replaceFile(name, path)
}
