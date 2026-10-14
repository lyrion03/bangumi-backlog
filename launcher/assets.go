package main

import (
	"embed"
	"io/fs"
)

//go:embed all:web
var assets embed.FS

func siteFiles() fs.FS {
	site, err := fs.Sub(assets, "web")
	if err != nil {
		panic(err)
	}
	return site
}
