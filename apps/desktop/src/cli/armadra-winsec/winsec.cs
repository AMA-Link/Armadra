// armadra-winsec：Windows 上给命名管道收紧访问控制（DACL）的小工具（控制台程序）。
//
// 为什么要有它：node:net 建命名管道用的是默认安全描述符（Everyone / Anonymous 可读），
// 而 Node 没有任何接口可以改一个已有管道的描述符。core 在 bind 之后调用这个程序，
// 它以客户端身份带 WRITE_DAC 打开管道，把 DACL 换成受保护的
//
//     D:P(D;;GA;;;NU)(A;;GA;;;SY)(A;;GA;;;<用户 SID>)
//
// 即拒绝网络登录（挡住远程 SMB 客户端）、只允许 SYSTEM 和本用户，然后把读回来的
// SDDL 打印出来，由 core 用纯函数核对（core/windows/acl.ts）。核对通过之前 core
// 不接受业务连接。
//
// 用法：
//   armadra-winsec harden-pipe <\\.\pipe\名字> <用户 SID>   成功时 stdout 打印读回的 SDDL
//   armadra-winsec read-pipe <\\.\pipe\名字>                 只读回，不修改
//
// 退出码 0 成功；非 0 失败，原因写 stderr（不含任何输入的值）。
//
// 只用 C# 5 与 .NET Framework 4：每台 Windows 10/11 都自带
// `%WINDIR%\Microsoft.NET\Framework*\v4.0.30319\csc.exe`，构建不需要另装工具链
// （apps/desktop/scripts/winsec-exe.mjs），以 anycpu 编译，在 arm64 上原生运行。
// 与 armadra-hook.exe 同一个先例，不加原生 npm 模块。

using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;

internal static class ArmadraWinsec
{
    private const uint READ_CONTROL = 0x00020000;
    private const uint WRITE_DAC = 0x00040000;
    private const uint FILE_SHARE_READ = 0x1;
    private const uint FILE_SHARE_WRITE = 0x2;
    private const uint OPEN_EXISTING = 3;
    private const int SE_KERNEL_OBJECT = 6;
    private const uint DACL_SECURITY_INFORMATION = 0x4;
    private const uint PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000;
    private const uint SDDL_REVISION_1 = 1;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFileW(
        string lpFileName, uint dwDesiredAccess, uint dwShareMode,
        IntPtr lpSecurityAttributes, uint dwCreationDisposition,
        uint dwFlagsAndAttributes, IntPtr hTemplateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(
        string stringSecurityDescriptor, uint revision,
        out IntPtr securityDescriptor, IntPtr securityDescriptorSize);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(
        IntPtr securityDescriptor, uint revision, uint securityInformation,
        out IntPtr stringSecurityDescriptor, IntPtr stringSecurityDescriptorLen);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetSecurityDescriptorDacl(
        IntPtr securityDescriptor, out bool daclPresent, out IntPtr dacl,
        out bool daclDefaulted);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern uint SetSecurityInfo(
        IntPtr handle, int objectType, uint securityInfo,
        IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern uint GetSecurityInfo(
        IntPtr handle, int objectType, uint securityInfo,
        IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl,
        out IntPtr securityDescriptor);

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 3 && args[0] == "harden-pipe")
            {
                return HardenPipe(args[1], args[2]);
            }
            if (args.Length == 2 && args[0] == "read-pipe")
            {
                return ReadPipe(args[1]);
            }
            Console.Error.WriteLine("usage: armadra-winsec harden-pipe <pipe> <sid> | read-pipe <pipe>");
            return 64;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("armadra-winsec: " + error.Message);
            return 1;
        }
    }

    private static bool IsPipePath(string path)
    {
        return path.StartsWith("\\\\.\\pipe\\", StringComparison.OrdinalIgnoreCase)
            && path.Length > 9
            && path.IndexOf('\\', 9) < 0;
    }

    private static bool IsSid(string sid)
    {
        if (!sid.StartsWith("S-1-", StringComparison.Ordinal)) return false;
        for (int i = 0; i < sid.Length; i++)
        {
            char c = sid[i];
            if (!(c == 'S' || c == '-' || (c >= '0' && c <= '9'))) return false;
        }
        return true;
    }

    private static IntPtr OpenPipe(string path)
    {
        // 只要改 / 读安全描述符的权利，不要数据权利：这条连接对服务端来说只是
        // 一次会马上断开的接入。
        IntPtr handle = CreateFileW(
            path, READ_CONTROL | WRITE_DAC, FILE_SHARE_READ | FILE_SHARE_WRITE,
            IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
        if (handle == new IntPtr(-1))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "cannot open the pipe");
        }
        return handle;
    }

    private static int HardenPipe(string path, string sid)
    {
        if (!IsPipePath(path)) throw new ArgumentException("not a pipe path");
        if (!IsSid(sid)) throw new ArgumentException("not a SID");
        string sddl = "D:P(D;;GA;;;NU)(A;;GA;;;SY)(A;;GA;;;" + sid + ")";
        IntPtr descriptor = IntPtr.Zero;
        IntPtr handle = IntPtr.Zero;
        try
        {
            if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl, SDDL_REVISION_1, out descriptor, IntPtr.Zero))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "bad descriptor");
            }
            bool present; bool defaulted; IntPtr dacl;
            if (!GetSecurityDescriptorDacl(descriptor, out present, out dacl, out defaulted)
                || !present)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "no DACL in descriptor");
            }
            handle = OpenPipe(path);
            uint status = SetSecurityInfo(
                handle, SE_KERNEL_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero);
            if (status != 0)
            {
                throw new Win32Exception((int)status, "cannot set the DACL");
            }
            Console.Out.WriteLine(ReadDacl(handle));
            return 0;
        }
        finally
        {
            if (handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(handle);
            if (descriptor != IntPtr.Zero) LocalFree(descriptor);
        }
    }

    private static int ReadPipe(string path)
    {
        if (!IsPipePath(path)) throw new ArgumentException("not a pipe path");
        IntPtr handle = IntPtr.Zero;
        try
        {
            handle = OpenPipe(path);
            Console.Out.WriteLine(ReadDacl(handle));
            return 0;
        }
        finally
        {
            if (handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(handle);
        }
    }

    private static string ReadDacl(IntPtr handle)
    {
        IntPtr descriptor;
        uint status = GetSecurityInfo(
            handle, SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION,
            IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out descriptor);
        if (status != 0)
        {
            throw new Win32Exception((int)status, "cannot read the DACL");
        }
        IntPtr text = IntPtr.Zero;
        try
        {
            if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(
                    descriptor, SDDL_REVISION_1, DACL_SECURITY_INFORMATION,
                    out text, IntPtr.Zero))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "cannot print the DACL");
            }
            return Marshal.PtrToStringUni(text);
        }
        finally
        {
            if (text != IntPtr.Zero) LocalFree(text);
            LocalFree(descriptor);
        }
    }
}
