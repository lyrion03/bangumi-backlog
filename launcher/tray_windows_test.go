package main

import (
	"fmt"
	"os"
	"testing"
	"time"
	"unsafe"
)

func TestTrayLayout(t *testing.T) {
	if unsafe.Sizeof(uintptr(0)) == 8 && (unsafe.Sizeof(notifyData{}) != 976 || unsafe.Sizeof(windowClass{}) != 80 || unsafe.Sizeof(winMessage{}) != 48) {
		t.Fatalf("invalid Windows structure sizes: %d %d %d", unsafe.Sizeof(notifyData{}), unsafe.Sizeof(windowClass{}), unsafe.Sizeof(winMessage{}))
	}
}
func TestTrayLifecycle(t *testing.T) {
	className := fmt.Sprintf("BangumiBacklog.Test.%d", os.Getpid())
	opened := make(chan string, 4)
	ready := make(chan struct{})
	done := make(chan error, 1)
	go func() { done <- runTray(className, func(path string) { opened <- path }, func() { close(ready) }) }()
	defer quitTray(className)
	select {
	case <-ready:
	case err := <-done:
		t.Fatal(err)
	case <-time.After(5 * time.Second):
		t.Fatal("tray startup timeout")
	}
	hwnd, _, _ := user32.NewProc("FindWindowW").Call(uintptr(unsafe.Pointer(utf16(className))), 0)
	if hwnd == 0 {
		t.Fatal("missing hidden tray window")
	}
	visible, _, _ := user32.NewProc("IsWindowVisible").Call(hwnd)
	if visible != 0 {
		t.Fatal("tray window visible")
	}
	for _, item := range []struct {
		id   uintptr
		want string
	}{{openCommand, ""}, {syncCommand, "/#sync"}} {
		postMessage.Call(hwnd, wmCommand, item.id, 0)
		select {
		case got := <-opened:
			if got != item.want {
				t.Fatal(got)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("tray command not handled")
		}
	}
	// Shell version 4 keyboard activation uses NIN_KEYSELECT in LOWORD(lParam).
	postMessage.Call(hwnd, trayMessage, 0, 0x401)
	select {
	case <-opened:
	case <-time.After(2 * time.Second):
		t.Fatal("tray activation failed")
	}
	restarted, _, _ := user32.NewProc("RegisterWindowMessageW").Call(uintptr(unsafe.Pointer(utf16("TaskbarCreated"))))
	postMessage.Call(hwnd, restarted, 0, 0)
	postMessage.Call(hwnd, wmCommand, exitCommand, 0)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("tray exit failed")
	}
}
