//go:build windows

package main

import (
	"os"
	"os/exec"
	"sync"
	"syscall"
	"unsafe"
)

// ctrlBreakEvent is CTRL_BREAK_EVENT; Go's os/signal delivers it to the API as os.Interrupt.
const ctrlBreakEvent = 1

var generateConsoleCtrlEvent = syscall.NewLazyDLL("kernel32.dll").NewProc("GenerateConsoleCtrlEvent")

// ownProcessGroup puts the API in a process group of its own, so a Ctrl+C in the console reaches
// this process first, which then stops the API and PostgreSQL in order.
func ownProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP}
}

// interrupt sends Ctrl+Break to the API's group for a graceful stop. Without a console to send it
// through, the API is killed: its open transactions roll back in PostgreSQL.
func interrupt(p *os.Process) error {
	if r, _, _ := generateConsoleCtrlEvent.Call(ctrlBreakEvent, uintptr(p.Pid)); r != 0 {
		return nil
	}
	return p.Kill()
}

// Job object API (kernel32), for children that never outlive the launcher.
var (
	createJobObject          = syscall.NewLazyDLL("kernel32.dll").NewProc("CreateJobObjectW")
	setInformationJobObject  = syscall.NewLazyDLL("kernel32.dll").NewProc("SetInformationJobObject")
	assignProcessToJobObject = syscall.NewLazyDLL("kernel32.dll").NewProc("AssignProcessToJobObject")
)

const (
	jobObjectExtendedLimitInformation = 9
	jobObjectLimitKillOnJobClose      = 0x2000
	processSetQuota                   = 0x0100
	processTerminate                  = 0x0001
)

type ioCounters struct {
	ReadOperationCount, WriteOperationCount, OtherOperationCount uint64
	ReadTransferCount, WriteTransferCount, OtherTransferCount    uint64
}

type jobBasicLimitInformation struct {
	PerProcessUserTimeLimit int64
	PerJobUserTimeLimit     int64
	LimitFlags              uint32
	MinimumWorkingSetSize   uintptr
	MaximumWorkingSetSize   uintptr
	ActiveProcessLimit      uint32
	Affinity                uintptr
	PriorityClass           uint32
	SchedulingClass         uint32
}

type jobExtendedLimitInformation struct {
	BasicLimitInformation jobBasicLimitInformation
	IoInfo                ioCounters
	ProcessMemoryLimit    uintptr
	JobMemoryLimit        uintptr
	PeakProcessMemoryUsed uintptr
	PeakJobMemoryUsed     uintptr
}

var (
	jobOnce   sync.Once
	jobHandle uintptr
)

// launcherJob is a job object that kills every process in it when its last handle closes, which
// happens when this launcher ends, however it ended. The handle is never closed on purpose.
func launcherJob() uintptr {
	jobOnce.Do(func() {
		h, _, _ := createJobObject.Call(0, 0)
		if h == 0 {
			return
		}
		var info jobExtendedLimitInformation
		info.BasicLimitInformation.LimitFlags = jobObjectLimitKillOnJobClose
		if r, _, _ := setInformationJobObject.Call(h, jobObjectExtendedLimitInformation,
			uintptr(unsafe.Pointer(&info)), unsafe.Sizeof(info)); r == 0 { //nolint:gosec // G103: the documented JOBOBJECT_EXTENDED_LIMIT_INFORMATION call
			_ = syscall.CloseHandle(syscall.Handle(h))
			return
		}
		jobHandle = h
	})
	return jobHandle
}

// bindToLauncher puts the API in the launcher's job, so it never outlives the launcher. Best
// effort: without the job the API still stops with the launcher's own stop.
func bindToLauncher(p *os.Process) {
	job := launcherJob()
	if job == 0 {
		return
	}
	h, err := syscall.OpenProcess(processSetQuota|processTerminate, false, uint32(p.Pid)) //nolint:gosec // G115: a Windows process id fits in uint32
	if err != nil {
		return
	}
	defer func() { _ = syscall.CloseHandle(h) }()
	_, _, _ = assignProcessToJobObject.Call(job, uintptr(h))
}
