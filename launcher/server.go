package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

var version = "2.0.0"

const appID = "bangumi-backlog"
const profileLimit = 1024 * 1024

var profileID = regexp.MustCompile("^[1-9][0-9]{0,9}$")
var profilePath = regexp.MustCompile("^/user/[a-zA-Z0-9_]+$")
var registrationPattern = regexp.MustCompile("\\bBangumi</span>\\s*<span\\b[^>]*>\\s*([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})\\s*加入")

type registrationEntry struct {
	date string
	at   time.Time
}
type profileReader struct {
	client *http.Client
	now    func() time.Time
	mu     sync.Mutex
	cache  map[string]registrationEntry
}

func newProfileReader() *profileReader {
	return &profileReader{
		client: &http.Client{Timeout: 7 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }},
		now:    time.Now, cache: make(map[string]registrationEntry),
	}
}
func parseRegistration(html string, now time.Time) string {
	match := registrationPattern.FindStringSubmatch(html)
	if match == nil {
		return ""
	}
	year, _ := strconv.Atoi(match[1])
	month, _ := strconv.Atoi(match[2])
	day, _ := strconv.Atoi(match[3])
	date := fmt.Sprintf("%04d-%02d-%02d", year, month, day)
	parsed, err := time.Parse("2006-01-02", date)
	if err != nil || year < 2000 || parsed.After(now) {
		return ""
	}
	return date
}
func (p *profileReader) read(ctx context.Context, id string) (string, error) {
	p.mu.Lock()
	cached, ok := p.cache[id]
	p.mu.Unlock()
	if ok && p.now().Sub(cached.at) < 24*time.Hour {
		return cached.date, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 7*time.Second)
	defer cancel()
	target, _ := url.Parse("https://bgm.tv/user/" + id)
	for attempt := 0; attempt < 3; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
		if err != nil {
			return "", err
		}
		req.Header.Set("User-Agent", "bangumi-backlog/"+version+" (+https://github.com/lyrion03/bangumi-backlog)")
		response, err := p.client.Do(req)
		if err != nil {
			return "", err
		}
		switch response.StatusCode {
		case 301, 302, 303, 307, 308:
			response.Body.Close()
			location := response.Header.Get("Location")
			if location == "" {
				return "", errors.New("missing redirect")
			}
			next, err := target.Parse(location)
			if err != nil || next.Scheme != "https" || next.Host != "bgm.tv" || next.User != nil || !profilePath.MatchString(next.Path) || next.RawQuery != "" || next.Fragment != "" {
				return "", errors.New("invalid profile redirect")
			}
			target = next
			continue
		}
		if response.StatusCode != http.StatusOK {
			response.Body.Close()
			return "", errors.New("profile unavailable")
		}
		body, err := io.ReadAll(io.LimitReader(response.Body, profileLimit+1))
		response.Body.Close()
		if err != nil || len(body) > profileLimit {
			return "", errors.New("invalid profile body")
		}
		date := parseRegistration(string(body), p.now())
		if date == "" {
			return "", errors.New("missing registration date")
		}
		p.mu.Lock()
		if len(p.cache) >= 100 {
			var oldest string
			var at time.Time
			for key, value := range p.cache {
				if oldest == "" || value.at.Before(at) {
					oldest = key
					at = value.at
				}
			}
			delete(p.cache, oldest)
		}
		p.cache[id] = registrationEntry{date, p.now()}
		p.mu.Unlock()
		return date, nil
	}
	return "", errors.New("too many redirects")
}
func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func newHandler(site fs.FS, address string, profiles *profileReader) http.Handler {
	files := http.FileServer(http.FS(site))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Cache-Control", "no-cache")
		if r.Host != address || (r.Header.Get("Origin") != "" && r.Header.Get("Origin") != "http://"+address) || r.Header.Get("Sec-Fetch-Site") == "cross-site" {
			http.Error(w, "Forbidden", 403)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/__bangumi/registration/") {
			id := strings.TrimPrefix(r.URL.Path, "/__bangumi/registration/")
			if r.Method != "GET" || !profileID.MatchString(id) {
				writeJSON(w, 400, struct{}{})
				return
			}
			date, err := profiles.read(r.Context(), id)
			if err != nil {
				writeJSON(w, 502, map[string]string{"error": "注册日期暂不可用"})
				return
			}
			number, _ := strconv.ParseInt(id, 10, 64)
			writeJSON(w, 200, map[string]any{"id": number, "registered": date})
			return
		}
		if r.Method != "GET" && r.Method != "HEAD" {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "Method not allowed", 405)
			return
		}
		if r.URL.Path == "/__backlog/status" {
			writeJSON(w, 200, map[string]string{"app": appID, "version": version})
			return
		}
		for _, part := range strings.Split(r.URL.Path, "/") {
			if part == ".." || strings.Contains(part, "\\") {
				http.NotFound(w, r)
				return
			}
		}
		target := strings.TrimPrefix(r.URL.Path, "/")
		if target == "" {
			target = "index.html"
		}
		file, err := site.Open(target)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		info, err := file.Stat()
		file.Close()
		if err != nil || info.IsDir() {
			http.NotFound(w, r)
			return
		}
		files.ServeHTTP(w, r)
	})
}
