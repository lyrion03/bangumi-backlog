package main

import (
	"fmt"
	"runtime"
	"syscall"
	"unsafe"
)

var user32 = syscall.NewLazyDLL("user32.dll")
var shell32 = syscall.NewLazyDLL("shell32.dll")
var kernel32 = syscall.NewLazyDLL("kernel32.dll")
var ole32 = syscall.NewLazyDLL("ole32.dll")
var registerClass = user32.NewProc("RegisterClassExW")
var unregisterClass = user32.NewProc("UnregisterClassW")
var createWindow = user32.NewProc("CreateWindowExW")
var defWindowProc = user32.NewProc("DefWindowProcW")
var destroyWindow = user32.NewProc("DestroyWindow")
var postQuit = user32.NewProc("PostQuitMessage")
var postMessage = user32.NewProc("PostMessageW")
var getMessage = user32.NewProc("GetMessageW")
var translateMessage = user32.NewProc("TranslateMessage")
var dispatchMessage = user32.NewProc("DispatchMessageW")
var notifyIcon = shell32.NewProc("Shell_NotifyIconW")

const trayMessage = 0x8001
const wmClose = 0x10
const wmDestroy = 2
const wmCommand = 0x111
const openCommand = 1
const syncCommand = 2
const exitCommand = 3

type point struct{ X, Y int32 }
type winMessage struct {
	Window         uintptr
	Message        uint32
	WParam, LParam uintptr
	Time           uint32
	Point          point
	Private        uint32
}
type windowClass struct {
	Size, Style                        uint32
	Proc                               uintptr
	ClassExtra, WindowExtra            int32
	Instance, Icon, Cursor, Background uintptr
	Menu, ClassName                    *uint16
	SmallIcon                          uintptr
}
type notifyData struct {
	Size               uint32
	Window             uintptr
	ID, Flags, Message uint32
	Icon               uintptr
	Tip                [128]uint16
	State, StateMask   uint32
	Info               [256]uint16
	Version            uint32
	Title              [64]uint16
	InfoFlags          uint32
	GUID               [16]byte
	BalloonIcon        uintptr
}

func utf16(s string) *uint16 { value, _ := syscall.UTF16PtrFromString(s); return value }
func showError(message string) {
	user32.NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(utf16(message))), uintptr(unsafe.Pointer(utf16("bangumi动画补标工具"))), 0x10)
}
func openBrowser(target string) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	initialized, _, _ := ole32.NewProc("CoInitializeEx").Call(0, 2)
	if initialized == 0 || initialized == 1 {
		defer ole32.NewProc("CoUninitialize").Call()
	}
	result, _, _ := shell32.NewProc("ShellExecuteW").Call(0, uintptr(unsafe.Pointer(utf16("open"))), uintptr(unsafe.Pointer(utf16(target))), 0, 0, 1)
	if result <= 32 {
		return fmt.Errorf("无法自动打开默认浏览器（%d）", result)
	}
	return nil
}
func quitTray(className string) error {
	hwnd, _, _ := user32.NewProc("FindWindowW").Call(uintptr(unsafe.Pointer(utf16(className))), 0)
	if hwnd != 0 {
		postMessage.Call(hwnd, wmClose, 0, 0)
	}
	return nil
}
func runTray(className string, onOpen func(string), ready func()) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	instance, _, _ := kernel32.NewProc("GetModuleHandleW").Call(0)
	icon, _, _ := user32.NewProc("LoadIconW").Call(instance, 1)
	if icon == 0 {
		icon, _, _ = user32.NewProc("LoadIconW").Call(0, 32512)
	}
	taskbarCreated, _, _ := user32.NewProc("RegisterWindowMessageW").Call(uintptr(unsafe.Pointer(utf16("TaskbarCreated"))))
	var hwnd uintptr
	data := notifyData{ID: 1, Flags: 1 | 2 | 4 | 128, Message: trayMessage, Icon: icon}
	data.Size = uint32(unsafe.Sizeof(data))
	copy(data.Tip[:], syscall.StringToUTF16("bangumi动画补标工具 · v"+version+"\n右键打开菜单，退出可停止服务"))
	added := false
	addIcon := func() bool {
		result, _, _ := notifyIcon.Call(0, uintptr(unsafe.Pointer(&data)))
		if result == 0 {
			return false
		}
		added = true
		data.Version = 4
		notifyIcon.Call(4, uintptr(unsafe.Pointer(&data)))
		return true
	}
	removeIcon := func() {
		if added {
			notifyIcon.Call(2, uintptr(unsafe.Pointer(&data)))
			added = false
		}
	}
	command := func(id uintptr) {
		switch id {
		case openCommand:
			go onOpen("")
		case syncCommand:
			go onOpen("/#sync")
		case exitCommand:
			destroyWindow.Call(hwnd)
		}
	}
	showMenu := func() {
		menu, _, _ := user32.NewProc("CreatePopupMenu").Call()
		if menu == 0 {
			return
		}
		defer user32.NewProc("DestroyMenu").Call(menu)
		appendMenu := user32.NewProc("AppendMenuW")
		appendMenu.Call(menu, 0, openCommand, uintptr(unsafe.Pointer(utf16("打开工具"))))
		appendMenu.Call(menu, 0, syncCommand, uintptr(unsafe.Pointer(utf16("同步中心"))))
		appendMenu.Call(menu, 0x800, 0, 0)
		appendMenu.Call(menu, 0, exitCommand, uintptr(unsafe.Pointer(utf16("退出"))))
		var position point
		user32.NewProc("GetCursorPos").Call(uintptr(unsafe.Pointer(&position)))
		user32.NewProc("SetForegroundWindow").Call(hwnd)
		chosen, _, _ := user32.NewProc("TrackPopupMenu").Call(menu, 0x100|2, uintptr(position.X), uintptr(position.Y), 0, hwnd, 0)
		postMessage.Call(hwnd, 0, 0, 0)
		if chosen != 0 {
			command(chosen)
		}
	}
	callback := syscall.NewCallback(func(window uintptr, message uint32, wparam, lparam uintptr) uintptr {
		switch message {
		case trayMessage:
			switch uint32(lparam) & 0xffff {
			case 0x400, 0x401:
				go onOpen("")
			case 0x7b:
				showMenu()
			}
			return 0
		case wmCommand:
			command(wparam & 0xffff)
			return 0
		case wmClose:
			destroyWindow.Call(window)
			return 0
		case wmDestroy:
			removeIcon()
			postQuit.Call(0)
			return 0
		}
		if uintptr(message) == taskbarCreated {
			addIcon()
			return 0
		}
		result, _, _ := defWindowProc.Call(window, uintptr(message), wparam, lparam)
		return result
	})
	class := windowClass{Proc: callback, Instance: instance, Icon: icon, SmallIcon: icon, ClassName: utf16(className)}
	class.Size = uint32(unsafe.Sizeof(class))
	registered, _, err := registerClass.Call(uintptr(unsafe.Pointer(&class)))
	if registered == 0 {
		return fmt.Errorf("无法初始化托盘窗口：%v", err)
	}
	defer unregisterClass.Call(uintptr(unsafe.Pointer(class.ClassName)), instance)
	hwnd, _, err = createWindow.Call(0, uintptr(unsafe.Pointer(class.ClassName)), uintptr(unsafe.Pointer(utf16("bangumi动画补标工具"))), 0, 0, 0, 0, 0, 0, 0, instance, 0)
	if hwnd == 0 {
		return fmt.Errorf("无法创建托盘窗口：%v", err)
	}
	defer destroyWindow.Call(hwnd)
	data.Window = hwnd
	if !addIcon() {
		return fmt.Errorf("无法显示系统托盘图标，请确认 Windows 桌面已启动后重试")
	}
	defer removeIcon()
	ready()
	var message winMessage
	for {
		status, _, err := getMessage.Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0)
		if int32(status) == -1 {
			return fmt.Errorf("托盘消息处理失败：%v", err)
		}
		if status == 0 {
			return nil
		}
		translateMessage.Call(uintptr(unsafe.Pointer(&message)))
		dispatchMessage.Call(uintptr(unsafe.Pointer(&message)))
	}
}
