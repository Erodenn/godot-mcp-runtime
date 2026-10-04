// Starts one program on a private Win32 desktop so none of its windows can
// become the foreground window of the desktop the user is working on.
//
//   launcher.exe <program> [args...]   run the program, exit with its code
//   launcher.exe --self-test           exit 0 when the whole path works here
//
// Target mode: when GODOT_MCP_TEST_LAUNCH_TARGET is set and non-empty, the
// program is that variable's value and EVERY argument is forwarded verbatim
// (the first argument is not treated as a program). This lets a caller that
// only knows how to run "the Godot executable" run it through this launcher by
// pointing its Godot path at the launcher. The flags above keep working
// regardless of the variable. Keep the variable name in sync with
// tests/helpers/private-desktop.ts.
//
// The child inherits this process's standard handles and environment, so the
// caller's pipes reach it directly. It is placed in a kill-on-close job: when
// this process ends for any reason, the child and everything it started end
// too. The desktop is destroyed by Windows once the last process on it exits
// and this process closes its handle.
//
// Built with the C# 5 compiler that ships in the .NET Framework 4 directory of
// every supported Windows, so the syntax stays within C# 5.
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

static class BackgroundLauncher
{
    const string DesktopPrefix = "godot-mcp-";
    const string SelfTestFlag = "--self-test";
    const string DesktopCheckFlag = "--desktop-check";
    const string LaunchTargetEnvVar = "GODOT_MCP_TEST_LAUNCH_TARGET";
    // Exit codes this launcher owns. A child may return anything, so these are
    // only meaningful together with the "godot-mcp-launcher:" stderr line.
    const int ExitUsage = 2;
    const int ExitLaunchFailed = 127;

    const uint STARTF_USESHOWWINDOW = 0x1;
    const uint STARTF_USESTDHANDLES = 0x100;
    const short SW_HIDE = 0;
    const uint CREATE_SUSPENDED = 0x4;
    const uint CREATE_NO_WINDOW = 0x08000000;
    const uint GENERIC_ALL = 0x10000000;
    const int STD_INPUT_HANDLE = -10;
    const int STD_OUTPUT_HANDLE = -11;
    const int STD_ERROR_HANDLE = -12;
    const uint INFINITE = 0xFFFFFFFF;
    const int JobObjectExtendedLimitInformation = 9;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    const int UOI_NAME = 2;
    const int NameCapacityChars = 256;
    const int BytesPerChar = 2;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS
    {
        public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION Basic;
        public IO_COUNTERS Io;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr procAttrs, IntPtr threadAttrs, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll")]
    static extern uint WaitForSingleObject(IntPtr handle, uint ms);
    [DllImport("kernel32.dll")]
    static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")]
    static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")]
    static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")]
    static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")]
    static extern IntPtr GetCommandLineW();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObjectW(IntPtr attrs, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateDesktopW(string name, IntPtr device, IntPtr devmode, uint flags, uint access, IntPtr attrs);
    [DllImport("user32.dll")]
    static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll")]
    static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll")]
    static extern IntPtr GetThreadDesktop(uint threadId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool GetUserObjectInformationW(IntPtr handle, int index, StringBuilder buffer, int lengthBytes, out int needed);

    static string ObjectName(IntPtr handle)
    {
        var name = new StringBuilder(NameCapacityChars);
        int needed;
        if (!GetUserObjectInformationW(handle, UOI_NAME, name, NameCapacityChars * BytesPerChar, out needed))
        {
            return null;
        }
        return name.ToString();
    }

    // The raw command line after this program's own name, so the child's
    // arguments keep the exact quoting the caller produced.
    static string CommandLineAfterProgramName()
    {
        string line = Marshal.PtrToStringUni(GetCommandLineW());
        int i = 0;
        bool quoted = false;
        while (i < line.Length && (quoted || (line[i] != ' ' && line[i] != '\t')))
        {
            if (line[i] == '"') quoted = !quoted;
            i++;
        }
        while (i < line.Length && (line[i] == ' ' || line[i] == '\t')) i++;
        return line.Substring(i);
    }

    static int Fail(string step)
    {
        Console.Error.WriteLine("godot-mcp-launcher: " + step + " failed (Win32 error " + Marshal.GetLastWin32Error() + ")");
        return ExitLaunchFailed;
    }

    static int RunOnPrivateDesktop(string commandLine)
    {
        string station = ObjectName(GetProcessWindowStation());
        if (station == null) return Fail("reading the window station name");
        string desktopName = DesktopPrefix + Process.GetCurrentProcess().Id;
        IntPtr desktop = CreateDesktopW(desktopName, IntPtr.Zero, IntPtr.Zero, 0, GENERIC_ALL, IntPtr.Zero);
        if (desktop == IntPtr.Zero) return Fail("CreateDesktop");

        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return Fail("CreateJobObject");
        var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.Basic.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr buffer = Marshal.AllocHGlobal(length);
        Marshal.StructureToPtr(limits, buffer, false);
        bool limited = SetInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, (uint)length);
        Marshal.FreeHGlobal(buffer);
        if (!limited) return Fail("SetInformationJobObject");

        var si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        si.lpDesktop = station + "\\" + desktopName;
        si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
        si.wShowWindow = SW_HIDE;
        si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
        si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
        si.hStdError = GetStdHandle(STD_ERROR_HANDLE);

        PROCESS_INFORMATION pi;
        // Suspended, so the child cannot start a process of its own before it
        // is inside the job.
        if (!CreateProcessW(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_NO_WINDOW, IntPtr.Zero, null, ref si, out pi))
        {
            return Fail("CreateProcess");
        }
        if (!AssignProcessToJobObject(job, pi.hProcess))
        {
            int failed = Fail("AssignProcessToJobObject");
            TerminateProcess(pi.hProcess, (uint)ExitLaunchFailed);
            return failed;
        }
        ResumeThread(pi.hThread);
        CloseHandle(pi.hThread);
        WaitForSingleObject(pi.hProcess, INFINITE);
        uint code;
        GetExitCodeProcess(pi.hProcess, out code);
        CloseHandle(pi.hProcess);
        CloseDesktop(desktop);
        return unchecked((int)code);
    }

    static int Main(string[] args)
    {
        // The internal flags win over the target variable, so the self-test
        // checks this launcher and is never redirected to the target.
        if (args.Length > 0 && args[0] == DesktopCheckFlag)
        {
            string desktop = ObjectName(GetThreadDesktop(GetCurrentThreadId()));
            return desktop != null && desktop.StartsWith(DesktopPrefix) ? 0 : 1;
        }
        if (args.Length > 0 && args[0] == SelfTestFlag)
        {
            string self = Process.GetCurrentProcess().MainModule.FileName;
            return RunOnPrivateDesktop("\"" + self + "\" " + DesktopCheckFlag);
        }
        string target = Environment.GetEnvironmentVariable(LaunchTargetEnvVar);
        if (!string.IsNullOrEmpty(target))
        {
            return RunOnPrivateDesktop("\"" + target + "\" " + CommandLineAfterProgramName());
        }
        if (args.Length == 0)
        {
            Console.Error.WriteLine("godot-mcp-launcher: usage: <program> [args...] | " + SelfTestFlag);
            return ExitUsage;
        }
        return RunOnPrivateDesktop(CommandLineAfterProgramName());
    }
}
