package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"strconv"
	"time"
)

func main() {
	if err := launch(); err != nil {
		showError(err.Error())
		os.Exit(1)
	}
}
func launch() error {
	noOpen := flag.Bool("no-open", false, "start without opening the browser")
	quit := flag.Bool("quit", false, "stop the launcher on the selected port")
	flag.Parse()
	port := os.Getenv("PORT")
	if port == "" {
		port = "4173"
	}
	number, err := strconv.Atoi(port)
	if err != nil || number < 1 || number > 65535 {
		return fmt.Errorf("PORT 必须是 1–65535 的有效端口")
	}
	address := "127.0.0.1:" + strconv.Itoa(number)
	className := "BangumiBacklogLauncher." + strconv.Itoa(number)
	if *quit {
		return quitTray(className)
	}
	browserURL := "http://" + address
	listener, err := net.Listen("tcp4", address)
	if err != nil {
		client := &http.Client{Timeout: 500 * time.Millisecond, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
		for attempt := 0; attempt < 5; attempt++ {
			res, e := client.Get(browserURL + "/__backlog/status")
			if e == nil {
				var data struct{ App string }
				e = json.NewDecoder(res.Body).Decode(&data)
				res.Body.Close()
				if e == nil && data.App == appID {
					if !*noOpen {
						return openBrowser(browserURL)
					}
					return nil
				}
			}
			time.Sleep(100 * time.Millisecond)
		}
		return fmt.Errorf("无法启动：端口 %s 已被占用。\n\n请先退出旧版工具或占用此端口的程序，再双击启动。\n为保留原有记录，本工具不会自动更换地址。", port)
	}
	defer listener.Close()
	server := &http.Server{Handler: newHandler(siteFiles(), address, newProfileReader()), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second}
	serveError := make(chan error, 1)
	go func() { serveError <- server.Serve(listener) }()
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
	}()
	err = runTray(className, func(fragment string) {
		if e := openBrowser(browserURL + fragment); e != nil {
			showError(e.Error() + "\n请手动打开 " + browserURL)
		}
	}, func() {
		if !*noOpen {
			go func() {
				if e := openBrowser(browserURL); e != nil {
					showError(e.Error() + "\n请手动打开 " + browserURL)
				}
			}()
		}
	})
	if err != nil {
		return err
	}
	select {
	case e := <-serveError:
		if e != nil && e != http.ErrServerClosed {
			return e
		}
	default:
	}
	return nil
}
