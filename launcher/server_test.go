package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

type transportFunc func(*http.Request) (*http.Response, error)

func (f transportFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func response(status int, body string, headers http.Header) *http.Response {
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: headers}
}
func TestRegistrationDate(t *testing.T) {
	now := time.Date(2026, 10, 14, 0, 0, 0, 0, time.UTC)
	for _, row := range []struct{ input, want string }{
		{"<span>Bangumi</span><span>2016-6-1 加入</span>", "2016-06-01"},
		{"Bangumi</span> <span class='foo'>2024-2-29 加入", "2024-02-29"},
		{"Bangumi</span><span>2023-2-29 加入", ""},
		{"Bangumi</span><span>2030-1-1 加入", ""},
		{"Bangumi</span><span>1999-1-1 加入", ""},
		{"no date", ""},
	} {
		if got := parseRegistration(row.input, now); got != row.want {
			t.Fatalf("%q: %s != %s", row.input, got, row.want)
		}
	}
}
func TestRegistrationRedirectAndCache(t *testing.T) {
	p := newProfileReader()
	calls := 0
	p.client.Transport = transportFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.Header.Get("Authorization") != "" {
			t.Fatal("token leaked")
		}
		if calls == 1 {
			return response(302, "", http.Header{"Location": []string{"/user/example"}}), nil
		}
		if r.URL.String() != "https://bgm.tv/user/example" {
			t.Fatal(r.URL)
		}
		return response(200, "Bangumi</span><span>2016-6-1 加入", nil), nil
	})
	for i := 0; i < 2; i++ {
		got, err := p.read(context.Background(), "123")
		if err != nil || got != "2016-06-01" {
			t.Fatal(got, err)
		}
	}
	if calls != 2 {
		t.Fatal(calls)
	}
}
func TestRegistrationRejectsUnsafeRedirects(t *testing.T) {
	for _, location := range []string{"http://127.0.0.1/private", "https://bgm.tv:443/user/test", "https://user:pw@bgm.tv/user/test", "https://bgm.tv/other", "/user/test?x=1", "/user/test#x", ""} {
		p := newProfileReader()
		calls := 0
		p.client.Transport = transportFunc(func(r *http.Request) (*http.Response, error) {
			calls++
			return response(302, "", http.Header{"Location": []string{location}}), nil
		})
		if _, err := p.read(context.Background(), "123"); err == nil || calls != 1 {
			t.Fatalf("accepted %s (%d)", location, calls)
		}
	}
}
func TestRegistrationCancellationAndSize(t *testing.T) {
	p := newProfileReader()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	p.client.Transport = transportFunc(func(r *http.Request) (*http.Response, error) { return nil, r.Context().Err() })
	if _, err := p.read(ctx, "1"); err == nil {
		t.Fatal("not cancelled")
	}
	p.client.Transport = transportFunc(func(r *http.Request) (*http.Response, error) {
		return response(200, strings.Repeat("x", profileLimit+1), nil), nil
	})
	if _, err := p.read(context.Background(), "1"); err == nil {
		t.Fatal("oversized body accepted")
	}
	if len(p.cache) != 0 {
		t.Fatal("failed data cached")
	}
}
func TestHTTPRoutesAndOrigin(t *testing.T) {
	p := newProfileReader()
	calls := 0
	p.client.Transport = transportFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		return response(200, "Bangumi</span><span>2018-1-2 加入", nil), nil
	})
	handler := newHandler(fstest.MapFS{"index.html": {Data: []byte("app")}, "assets/app.js": {Data: []byte("export {}")}}, "127.0.0.1:4173", p)
	for _, row := range []struct {
		method, path, host, origin, site string
		status                           int
	}{
		{"GET", "/", "127.0.0.1:4173", "", "", 200},
		{"HEAD", "/assets/app.js", "127.0.0.1:4173", "", "", 200},
		{"GET", "/__backlog/status", "127.0.0.1:4173", "", "", 200},
		{"GET", "/assets/", "127.0.0.1:4173", "", "", 404},
		{"GET", "/../go.mod", "127.0.0.1:4173", "", "", 404},
		{"POST", "/", "127.0.0.1:4173", "", "", 405},
		{"GET", "/__bangumi/registration/100", "127.0.0.1:4173", "", "", 200},
		{"POST", "/__bangumi/registration/100", "127.0.0.1:4173", "", "", 400},
		{"GET", "/__bangumi/registration/invalid", "127.0.0.1:4173", "", "", 400},
		{"GET", "/", "evil.example", "", "", 403},
		{"GET", "/", "127.0.0.1:4173", "https://evil.example", "", 403},
		{"GET", "/", "127.0.0.1:4173", "", "cross-site", 403},
	} {
		r := httptest.NewRequest(row.method, "http://127.0.0.1:4173"+row.path, nil)
		r.Host = row.host
		r.Header.Set("Origin", row.origin)
		r.Header.Set("Sec-Fetch-Site", row.site)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != row.status {
			t.Fatalf("%s %s: %d != %d", row.method, row.path, w.Code, row.status)
		}
		if row.method == "HEAD" && w.Body.Len() != 0 {
			t.Fatal("HEAD body")
		}
		if w.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Fatal("missing header")
		}
	}
	if calls != 1 {
		t.Fatal("invalid request reached Bangumi")
	}
}
