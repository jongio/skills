using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal sealed class AttentionCommand
{
    public string type { get; set; }
    public long generation { get; set; }
    public string kind { get; set; }
    public string style { get; set; }
    public string color { get; set; }
    public bool acknowledged { get; set; }
    public string previewId { get; set; }
    [ScriptIgnore] public long ReceivedAt { get; set; }
}

internal sealed class AttentionLatch
{
    public long Generation = -1;
    public bool Active, Acknowledged;
    public string Style = "both", Color = "#FFBB24";
    public string PreviewId;
    private bool wasAway;
    private long inputAtStart;
    private long receivedAt;

    public void Update(AttentionCommand command, bool focused, long inputSequence)
    {
        if (command.generation < Generation) return;
        if (command.generation > Generation)
        {
            Generation = command.generation;
            Acknowledged = command.acknowledged;
            wasAway = !focused;
            inputAtStart = inputSequence;
            receivedAt = command.ReceivedAt;
        }
        else Acknowledged |= command.acknowledged;
        Active = command.kind != null;
        Style = command.style;
        Color = command.color;
        PreviewId = command.previewId;
    }

    public bool Show(bool focused, long inputSequence, bool settled = true, long inputTimestamp = long.MaxValue)
    {
        if (!focused) wasAway = true;
        if (Active && !Acknowledged && focused && settled &&
            (wasAway || (inputSequence > inputAtStart && inputTimestamp > receivedAt)))
            Acknowledged = true;
        return Active && !Acknowledged;
    }
}

internal sealed class AttentionFocus
{
    private readonly IntPtr target;
    private long focusedSince = -1, interactionSince = -1;
    public bool Focused, Settled;
    public long InputSequence, SettledInputSequence;
    public long InputTimestamp, SettledInputTimestamp;

    public AttentionFocus(IntPtr window, long inputSequence)
    {
        target = window;
        InputSequence = SettledInputSequence = inputSequence;
    }

    public void Observe(IntPtr foreground, long milliseconds)
    {
        Focused = target != IntPtr.Zero && foreground == target;
        if (!Focused)
        {
            focusedSince = interactionSince = -1;
            Settled = false;
            return;
        }
        if (focusedSince < 0) focusedSince = milliseconds;
        Settled = milliseconds - focusedSince >= 250;
        if (Settled && interactionSince >= 0 && milliseconds - interactionSince >= 250)
        {
            SettledInputSequence = InputSequence;
            SettledInputTimestamp = InputTimestamp;
            interactionSince = -1;
        }
    }

    public void Interact(IntPtr foreground, long milliseconds, long occurredAt = -1)
    {
        Observe(foreground, milliseconds);
        if (Focused)
        {
            InputSequence++;
            InputTimestamp = occurredAt >= 0 ? occurredAt : milliseconds;
            if (interactionSince < 0) interactionSince = milliseconds;
        }
    }
}

internal sealed class AttentionFrameSchedule
{
    private long nextFrame;
    public bool Take(long milliseconds)
    {
        if (milliseconds < nextFrame) return false;
        nextFrame = milliseconds + 250;
        return true;
    }
    public void Reset() { nextFrame = 0; }
    public uint Delay(long milliseconds) { return (uint)Math.Max(0, Math.Min(100, nextFrame - milliseconds)); }
}

internal static class TerminalAttention
{
    private const uint Popup = 0x80000000;
    private const uint OverlayStyle = 0x00080000 | 0x00000020 | 0x00000080 | 0x08000000;
    private const uint MoveFlags = 0x0010 | 0x0200 | 0x0400;
    private const int ExtendedStyleIndex = -20;
    private const int TopmostStyle = 0x00000008;
    private const int MessageBatchLimit = 64;
    private static readonly IntPtr TopmostBand = new IntPtr(-1);
    private static readonly IntPtr NonTopmostBand = new IntPtr(-2);
    private static readonly WindowProc Callback = Dispatch;
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 8192 };
    private static readonly string ClassName = "CopilotSessionAttention_" + Process.GetCurrentProcess().Id;
    private static readonly ConcurrentQueue<AttentionCommand> Commands = new ConcurrentQueue<AttentionCommand>();
    private static readonly AutoResetEvent CommandSignal = new AutoResetEvent(false);
    private static readonly AttentionFrameSchedule FrameSchedule = new AttentionFrameSchedule();
    private static volatile bool inputClosed;
    private static Exception inputError;
    private static TextWriter output;
    private static IntPtr brush, border, wash, consoleWindow, target, oldDpiContext;
    private static uint consoleProcessId, consoleThreadId;
    private static int lastWidth, lastHeight, lastDpi;
    private static bool registered, lastMaximized, lastTopmost;
    private static bool inputListening, presentationValid, borderVisible, washVisible;
    private static int lastX, lastY;
    private static IntPtr lastAnchor;
    private static string lastStyle;
    private static int borderAlpha = -1, washAlpha = -1;
    private static long positionCalls, alphaCalls, visibilityCalls;
    private static long paintedFrames;
    private static string safetyStage;
    private static Mutex windowLease;
    private static bool leaseHeld;
    private static string currentColor;
    private static IntPtr inputBuffer;
    private static long inputSequence;
    private static readonly Stopwatch FocusClock = Stopwatch.StartNew();
    private static AttentionFocus focus;
    private static readonly uint InputHeaderSize = (uint)Marshal.SizeOf(typeof(RawInputHeader));

    [StructLayout(LayoutKind.Sequential)]
    private struct WindowClass
    {
        public uint size, style;
        public WindowProc procedure;
        public int classExtra, windowExtra;
        public IntPtr instance, icon, cursor, background;
        [MarshalAs(UnmanagedType.LPWStr)] public string menuName;
        [MarshalAs(UnmanagedType.LPWStr)] public string className;
        public IntPtr smallIcon;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Rectangle
    {
        public int Left, Top, Right, Bottom;
        public int Width { get { return Right - Left; } }
        public int Height { get { return Bottom - Top; } }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Message
    {
        public IntPtr window;
        public uint message;
        public UIntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public int x, y;
        public uint privateData;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessEntry
    {
        public uint size, usage, processId;
        public IntPtr heap;
        public uint moduleId, threads, parentId;
        public int priority;
        public uint flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string name;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RawInputDevice
    {
        public ushort usagePage, usage;
        public uint flags;
        public IntPtr window;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RawInputHeader
    {
        public uint type, size;
        public IntPtr device, parameter;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Point
    {
        public int X, Y;
    }

    private delegate IntPtr WindowProc(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern ushort RegisterClassEx(ref WindowClass definition);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateWindowEx(uint extendedStyle, string className, string title, uint style,
        int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr DefWindowProc(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool DestroyWindow(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool UnregisterClass(string className, IntPtr instance);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetLayeredWindowAttributes(IntPtr window, uint color, byte alpha, uint flags);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern int SetWindowRgn(IntPtr window, IntPtr region, bool redraw);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Rectangle rectangle);
    [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr window, out Rectangle rectangle);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll", SetLastError = true)] private static extern int GetWindowLong(IntPtr window, int index);
    [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll")] private static extern uint GetGuiResources(IntPtr process, uint flags);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool PostMessage(IntPtr window, uint message, UIntPtr parameter, IntPtr value);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr parameter,
        IntPtr value, uint flags, uint timeout, out UIntPtr result);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] private static extern bool IsChild(IntPtr parent, IntPtr window);
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] private static extern int GetMessageTime();
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterRawInputDevices(RawInputDevice[] devices, uint count, uint size);
    [DllImport("user32.dll")]
    private static extern uint GetRawInputData(IntPtr input, uint command, IntPtr data, ref uint size, uint headerSize);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsZoomed(IntPtr window);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr window, StringBuilder text, int capacity);
    [DllImport("user32.dll")] private static extern bool PeekMessage(out Message message, IntPtr window, uint min, uint max, uint remove);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr DispatchMessage(ref Message message);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint MsgWaitForMultipleObjectsEx(uint count, IntPtr[] handles, uint milliseconds, uint wakeMask, uint flags);
    [DllImport("user32.dll")] private static extern bool InvalidateRect(IntPtr window, IntPtr rectangle, bool erase);
    [DllImport("user32.dll")] private static extern bool UpdateWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern int FillRect(IntPtr context, ref Rectangle rectangle, IntPtr background);
    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out Rectangle value, int size);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")]
    private static extern int DwmGetWindowValue(IntPtr window, int attribute, out uint value, int size);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateSolidBrush(uint color);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateRoundRectRgn(int left, int top, int right, int bottom, int ellipseWidth, int ellipseHeight);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);
    [DllImport("gdi32.dll")] private static extern int CombineRgn(IntPtr destination, IntPtr first, IntPtr second, int mode);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr value);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr GetModuleHandle(string module);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AttachConsole(uint processId);
    [DllImport("kernel32.dll")] private static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AllocConsole();
    [DllImport("kernel32.dll")] private static extern IntPtr GetConsoleWindow();
    [DllImport("kernel32.dll")] private static extern IntPtr GetStdHandle(int handle);
    [DllImport("kernel32.dll")] private static extern bool SetStdHandle(int handle, IntPtr value);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern bool Process32First(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] private static extern ulong GetTickCount64();
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] private static extern bool GetProcessHandleCount(IntPtr process, out uint count);

    private static void Check(bool success)
    {
        if (!success) throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    private static string WindowClassName(IntPtr window)
    {
        var text = new StringBuilder(256);
        GetClassName(window, text, text.Capacity);
        return text.ToString();
    }

    private static IntPtr TerminalOwner(IntPtr window)
    {
        if (!IsWindow(window) || WindowClassName(window) != "PseudoConsoleWindow") return IntPtr.Zero;
        uint processId;
        uint threadId = GetWindowThreadProcessId(window, out processId);
        if (consoleWindow == window && (processId != consoleProcessId || threadId != consoleThreadId)) return IntPtr.Zero;
        IntPtr owner = GetAncestor(window, 3);
        return WindowClassName(owner) == "CASCADIA_HOSTING_WINDOW_CLASS" ? owner : IntPtr.Zero;
    }

    private static void Bind(uint ownerId)
    {
        var parents = new Dictionary<uint, uint>();
        IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
        if (snapshot == new IntPtr(-1)) throw new Win32Exception();
        try
        {
            var entry = new ProcessEntry { size = (uint)Marshal.SizeOf(typeof(ProcessEntry)) };
            if (Process32First(snapshot, ref entry))
                do { parents[entry.processId] = entry.parentId; } while (Process32Next(snapshot, ref entry));
        }
        finally { CloseHandle(snapshot); }
        IntPtr input = GetStdHandle(-10), stdout = GetStdHandle(-11), stderr = GetStdHandle(-12);
        try
        {
            FreeConsole();
            var seen = new HashSet<uint>();
            for (uint processId = ownerId; processId != 0 && seen.Count < 12 && seen.Add(processId);)
            {
                if (AttachConsole(processId))
                {
                    IntPtr window = GetConsoleWindow();
                    IntPtr terminal = TerminalOwner(window);
                    FreeConsole();
                    if (terminal != IntPtr.Zero)
                    {
                        consoleWindow = window;
                        consoleThreadId = GetWindowThreadProcessId(window, out consoleProcessId);
                        target = terminal;
                        return;
                    }
                    throw new NotSupportedException("The session console has no verified Windows Terminal owner; no ancestor window was selected.");
                }
                uint parent;
                if (!parents.TryGetValue(processId, out parent)) break;
                processId = parent;
            }
        }
        finally
        {
            FreeConsole();
            SetStdHandle(-10, input);
            SetStdHandle(-11, stdout);
            SetStdHandle(-12, stderr);
        }
        throw new InvalidOperationException("Could not bind this session's console to Windows Terminal; no window was selected.");
    }

    private static IntPtr Dispatch(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam)
    {
        if (message == 0x00FF && inputBuffer != IntPtr.Zero) ObserveInput(lParam);
        if (message == 0x0021) return new IntPtr(3);
        if (message == 0x0084) return new IntPtr(-1);
        if (message == 0x0014 && brush != IntPtr.Zero)
        {
            Rectangle rectangle;
            GetClientRect(window, out rectangle);
            IntPtr context = IntPtr.Size == 8 ? new IntPtr(unchecked((long)wParam.ToUInt64())) :
                new IntPtr(unchecked((int)wParam.ToUInt32()));
            FillRect(context, ref rectangle, brush);
            return new IntPtr(1);
        }
        return DefWindowProc(window, message, wParam, lParam);
    }

    private static bool TargetFocused()
    {
        return target != IntPtr.Zero && GetForegroundWindow() == target;
    }

    private static bool IsEditingKey(int key, bool released, bool control, bool shift, bool alt, bool windows)
    {
        if (released || windows || key == 0x10 || key == 0x11 || key == 0x12 || key == 0x5B || key == 0x5C ||
            (key >= 0xA0 && key <= 0xA5)) return false;
        if (alt && (key == 0x09 || key == 0x1B || key == 0x20 || key == 0x73)) return false;
        if (control && (key == 0x09 || (shift && (key == 0x4E || key == 0x54)))) return false;
        return true;
    }

    private static void ObserveInput(IntPtr input)
    {
        if (!TargetFocused()) return;
        uint size = 64;
        uint read = GetRawInputData(input, 0x10000003, inputBuffer, ref size, InputHeaderSize);
        if (read == uint.MaxValue || read < InputHeaderSize + 8) return;
        int type = Marshal.ReadInt32(inputBuffer);
        ulong now = GetTickCount64();
        long occurredAt = (long)now - unchecked((uint)now - (uint)GetMessageTime());
        if (type == 1)
        {
            int key = (ushort)Marshal.ReadInt16(inputBuffer, (int)InputHeaderSize + 6);
            bool released = (Marshal.ReadInt16(inputBuffer, (int)InputHeaderSize + 2) & 1) != 0;
            if (!IsEditingKey(key, released, GetAsyncKeyState(0x11) < 0, GetAsyncKeyState(0x10) < 0,
                GetAsyncKeyState(0x12) < 0, GetAsyncKeyState(0x5B) < 0 || GetAsyncKeyState(0x5C) < 0)) return;
            focus.Interact(GetForegroundWindow(), FocusClock.ElapsedMilliseconds, occurredAt);
        }
        else if (type == 0 && (Marshal.ReadInt16(inputBuffer, (int)InputHeaderSize + 4) & 0x0D55) != 0)
        {
            Point point;
            if (!GetCursorPos(out point)) return;
            IntPtr under = WindowFromPoint(point);
            if (under == target || IsChild(target, under))
                focus.Interact(GetForegroundWindow(), FocusClock.ElapsedMilliseconds, occurredAt);
        }
    }

    private static string LeaseName(IntPtr window)
    {
        uint processId;
        GetWindowThreadProcessId(window, out processId);
        return "Local\\CopilotAttention_" + processId + "_" + window.ToInt64();
    }

    private static void AcquireWindowLease()
    {
        windowLease = new Mutex(false, LeaseName(target));
        try { leaseHeld = windowLease.WaitOne(0); }
        catch (AbandonedMutexException) { leaseHeld = true; }
        if (!leaseHeld)
        {
            windowLease.Dispose();
            windowLease = null;
            throw new InvalidOperationException("Another attention renderer already uses this Terminal window; use one Copilot session per window.");
        }
    }

    private static void ReleaseWindowLease()
    {
        if (windowLease == null) return;
        if (leaseHeld) windowLease.ReleaseMutex();
        windowLease.Dispose();
        windowLease = null;
        leaseHeld = false;
    }

    private static void SetInputListening(bool enabled)
    {
        if (enabled == inputListening) return;
        var devices = new[] {
            new RawInputDevice { usagePage = 1, usage = 2, flags = enabled ? 0x100u : 1u, window = enabled ? wash : IntPtr.Zero },
            new RawInputDevice { usagePage = 1, usage = 6, flags = enabled ? 0x100u : 1u, window = enabled ? wash : IntPtr.Zero }
        };
        Check(RegisterRawInputDevices(devices, (uint)devices.Length, (uint)Marshal.SizeOf(typeof(RawInputDevice))));
        inputListening = enabled;
    }

    private static void Initialize()
    {
        AcquireWindowLease();
        focus = new AttentionFocus(target, inputSequence);
        if (oldDpiContext == IntPtr.Zero) oldDpiContext = SetThreadDpiAwarenessContext(new IntPtr(-4));
        var definition = new WindowClass {
            size = (uint)Marshal.SizeOf(typeof(WindowClass)), procedure = Callback,
            instance = GetModuleHandle(null), className = ClassName
        };
        if (RegisterClassEx(ref definition) == 0) throw new Win32Exception();
        registered = true;
        // A foreign owner joins input queues and can freeze that application's UI.
        wash = CreateWindowEx(OverlayStyle, ClassName, "Copilot attention background", Popup,
            0, 0, 1, 1, IntPtr.Zero, IntPtr.Zero, definition.instance, IntPtr.Zero);
        border = CreateWindowEx(OverlayStyle, ClassName, "Copilot attention border", Popup,
            0, 0, 1, 1, IntPtr.Zero, IntPtr.Zero, definition.instance, IntPtr.Zero);
        if (wash == IntPtr.Zero || border == IntPtr.Zero) throw new Win32Exception();
        if (GetWindow(wash, 4) != IntPtr.Zero || GetWindow(border, 4) != IntPtr.Zero)
            throw new InvalidOperationException("Attention surfaces are not isolated; the renderer was stopped.");
        if (inputBuffer == IntPtr.Zero) inputBuffer = Marshal.AllocHGlobal(64);
        presentationValid = false;
        borderVisible = washVisible = false;
        borderAlpha = washAlpha = -1;
        lastStyle = null;
        FrameSchedule.Reset();
    }

    private static Rectangle Bounds()
    {
        Rectangle bounds;
        if (DwmGetWindowAttribute(target, 9, out bounds, Marshal.SizeOf(typeof(Rectangle))) != 0 &&
            !GetWindowRect(target, out bounds)) throw new Win32Exception();
        return bounds;
    }

    private static void SetRegion(IntPtr window, Rectangle bounds, bool ring)
    {
        int thickness = Math.Max(6, (int)Math.Round(7.0 * GetDpiForWindow(target) / 96));
        int radius = IsZoomed(target) ? 0 : Math.Max(12, thickness * 2);
        IntPtr outer = radius == 0 ? CreateRectRgn(0, 0, bounds.Width, bounds.Height) :
            CreateRoundRectRgn(0, 0, bounds.Width + 1, bounds.Height + 1, radius, radius);
        if (outer == IntPtr.Zero) throw new Win32Exception();
        try
        {
            if (ring)
            {
                IntPtr inner = radius == 0 ?
                    CreateRectRgn(thickness, thickness, bounds.Width - thickness, bounds.Height - thickness) :
                    CreateRoundRectRgn(thickness, thickness, bounds.Width - thickness + 1,
                        bounds.Height - thickness + 1, Math.Max(2, radius - thickness), Math.Max(2, radius - thickness));
                if (inner == IntPtr.Zero) throw new Win32Exception();
                try { if (CombineRgn(outer, outer, inner, 4) == 0) throw new Win32Exception(); }
                finally { DeleteObject(inner); }
            }
            if (SetWindowRgn(window, outer, true) == 0) throw new Win32Exception();
            outer = IntPtr.Zero;
        }
        finally { if (outer != IntPtr.Zero) DeleteObject(outer); }
    }

    private static void SetColor(string color)
    {
        if (color == currentColor) return;
        uint rgb = uint.Parse(color.Substring(1), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
        uint bgr = ((rgb & 255) << 16) | (rgb & 0xFF00) | (rgb >> 16);
        IntPtr replacement = CreateSolidBrush(bgr);
        if (replacement == IntPtr.Zero) throw new Win32Exception();
        if (brush != IntPtr.Zero) DeleteObject(brush);
        brush = replacement;
        currentColor = color;
        foreach (IntPtr window in new[] { border, wash })
        {
            InvalidateRect(window, IntPtr.Zero, true);
            UpdateWindow(window);
        }
    }

    private struct WindowOrder
    {
        public IntPtr Anchor, Lower;
    }

    private static WindowOrder FindWindowOrder()
    {
        IntPtr lower = target, previous = GetWindow(target, 3);
        for (int attempt = 0; attempt < 32; attempt++)
        {
            if (previous == IntPtr.Zero) return new WindowOrder { Anchor = previous, Lower = lower };
            if (previous != border && previous != wash)
            {
                if (GetAncestor(previous, 3) != target) return new WindowOrder { Anchor = previous, Lower = lower };
                lower = previous;
            }
            previous = GetWindow(previous, 3);
        }
        throw new InvalidOperationException("Attention window ordering did not stabilize; renderer stopped.");
    }

    private static IntPtr Anchor() { return FindWindowOrder().Anchor; }

    private static void SetAlpha(IntPtr window, int alpha, ref int previous)
    {
        if (alpha == previous) return;
        Check(SetLayeredWindowAttributes(window, 0, (byte)alpha, 2));
        previous = alpha;
        alphaCalls++;
    }

    private static bool IsTopmost(IntPtr window)
    {
        return window != IntPtr.Zero && (GetWindowLong(window, ExtendedStyleIndex) & TopmostStyle) != 0;
    }

    private static bool SurfaceOrderMatches(string style, IntPtr lowerWindow)
    {
        bool topmost = IsTopmost(target);
        if ((style != "background" && IsTopmost(border) != topmost) ||
            (style != "border" && IsTopmost(wash) != topmost))
            return false;
        IntPtr unused = style == "border" ? wash : style == "background" ? border : IntPtr.Zero;
        IntPtr previous = GetWindow(lowerWindow, 3);
        for (int attempt = 0; attempt < 3 && unused != IntPtr.Zero && previous == unused; attempt++)
            previous = GetWindow(previous, 3);
        IntPtr lower = style == "border" ? border : wash;
        return previous == lower && (style != "both" || GetWindow(wash, 3) == border);
    }

    private static void HideSurface(IntPtr window, ref bool visible)
    {
        if (window != IntPtr.Zero && (visible || IsWindowVisible(window)))
        {
            ShowWindow(window, 0);
            visibilityCalls++;
        }
        visible = false;
    }

    private static void Place(IntPtr window, IntPtr after, Rectangle bounds, bool visible, bool topmost)
    {
        IntPtr effectiveAfter = after;
        if (after == IntPtr.Zero)
        {
            if (topmost) effectiveAfter = TopmostBand;
            else if (IsTopmost(window)) effectiveAfter = NonTopmostBand;
        }
        else if (IsTopmost(window) != topmost)
        {
            Check(SetWindowPos(window, topmost ? TopmostBand : NonTopmostBand, 0, 0, 0, 0,
                MoveFlags | 0x0001u | 0x0002u));
        }
        Check(SetWindowPos(window, effectiveAfter, bounds.Left, bounds.Top, bounds.Width, bounds.Height,
            MoveFlags | (visible ? 0x0040u : 0u)));
        positionCalls++;
    }

    private static void PaintFrame(string style, string color, double seconds, Rectangle bounds, bool show)
    {
        paintedFrames++;
        int dpi = (int)GetDpiForWindow(target);
        bool maximized = IsZoomed(target);
        bool topmost = IsTopmost(target);
        bool resized = bounds.Width != lastWidth || bounds.Height != lastHeight || dpi != lastDpi || maximized != lastMaximized;
        if (resized)
        {
            SetRegion(border, bounds, true);
            SetRegion(wash, bounds, false);
            lastWidth = bounds.Width;
            lastHeight = bounds.Height;
            lastDpi = dpi;
            lastMaximized = maximized;
        }
        SetColor(color);
        double pulse = (1 + Math.Sin(seconds * Math.PI)) / 2;
        if (style != "background") SetAlpha(border, (int)(170 + 80 * pulse), ref borderAlpha);
        if (style != "border") SetAlpha(wash, (int)(30 + 30 * pulse), ref washAlpha);
        WindowOrder order = FindWindowOrder();
        IntPtr after = order.Anchor;
        if (presentationValid && !resized && bounds.Left == lastX && bounds.Top == lastY &&
            after == lastAnchor && style == lastStyle && topmost == lastTopmost &&
            SurfaceOrderMatches(style, order.Lower) && (!show ||
                (borderVisible == (style != "background") && washVisible == (style != "border") &&
                    IsWindowVisible(border) == borderVisible && IsWindowVisible(wash) == washVisible))) return;
        lastAnchor = after;
        lastX = bounds.Left;
        lastY = bounds.Top;
        lastStyle = style;
        lastTopmost = topmost;
        presentationValid = true;
        if (style != "background")
        {
            Place(border, after, bounds, show, topmost);
            borderVisible = show;
            after = border;
        }
        else HideSurface(border, ref borderVisible);
        if (style != "border")
        {
            Place(wash, after, bounds, show, topmost);
            washVisible = show;
        }
        else HideSurface(wash, ref washVisible);
    }

    private static void Render(string style, string color, long milliseconds)
    {
        if (!FrameSchedule.Take(milliseconds)) return;
        Rectangle bounds = Bounds();
        uint cloaked;
        bool hidden = DwmGetWindowValue(target, 14, out cloaked, sizeof(uint)) == 0 && cloaked != 0;
        if (!IsWindowVisible(target) || !IsWindowEnabled(target) || IsIconic(target) || hidden ||
            bounds.Width < 30 || bounds.Height < 30)
        {
            Hide();
            return;
        }
        PaintFrame(style, color, milliseconds / 1000.0, bounds, true);
    }

    private static void Hide()
    {
        HideSurface(border, ref borderVisible);
        HideSurface(wash, ref washVisible);
        presentationValid = false;
    }

    private static void Cleanup()
    {
        try { if (inputListening) SetInputListening(false); } catch (Win32Exception) { inputListening = false; }
        if (inputBuffer != IntPtr.Zero) { Marshal.FreeHGlobal(inputBuffer); inputBuffer = IntPtr.Zero; }
        if (border != IntPtr.Zero) { DestroyWindow(border); border = IntPtr.Zero; }
        if (wash != IntPtr.Zero) { DestroyWindow(wash); wash = IntPtr.Zero; }
        if (registered) { UnregisterClass(ClassName, GetModuleHandle(null)); registered = false; }
        if (brush != IntPtr.Zero) { DeleteObject(brush); brush = IntPtr.Zero; }
        if (oldDpiContext != IntPtr.Zero) { SetThreadDpiAwarenessContext(oldDpiContext); oldDpiContext = IntPtr.Zero; }
        currentColor = null;
        lastWidth = lastHeight = lastDpi = 0;
        lastTopmost = presentationValid = borderVisible = washVisible = false;
        ReleaseWindowLease();
    }

    private static int PumpMessages()
    {
        Message message;
        int count = 0;
        while (count < MessageBatchLimit && PeekMessage(out message, IntPtr.Zero, 0, 0, 1))
        {
            TranslateMessage(ref message);
            DispatchMessage(ref message);
            count++;
        }
        return count;
    }

    private static void WaitForWork(uint milliseconds)
    {
        if (MsgWaitForMultipleObjectsEx(1, new[] { CommandSignal.SafeWaitHandle.DangerousGetHandle() },
            milliseconds, 0x04FF, 0x0004) == uint.MaxValue) throw new Win32Exception();
    }

    private static void Emit(object message)
    {
        output.WriteLine(Json.Serialize(message));
        output.Flush();
    }

    private static void ReadCommands(TextReader input)
    {
        try
        {
            var parser = new JavaScriptSerializer { MaxJsonLength = 8192 };
            string line;
            while ((line = input.ReadLine()) != null)
            {
                AttentionCommand command = parser.Deserialize<AttentionCommand>(line);
                if (command == null || (command.type != "alert" && command.type != "preview") ||
                    command.generation < 0 ||
                    (command.style != "border" && command.style != "background" && command.style != "both") ||
                    command.color == null || command.color.Length != 7 || command.color[0] != '#' ||
                    (command.kind != null && command.kind != "approval" && command.kind != "question" &&
                        command.kind != "ready" && command.kind != "error"))
                    throw new InvalidDataException("Invalid attention command.");
                uint color;
                if (!uint.TryParse(command.color.Substring(1), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out color))
                    throw new InvalidDataException("Invalid attention color.");
                Guid previewId;
                if (command.type == "preview" && (!Guid.TryParse(command.previewId, out previewId) || previewId == Guid.Empty))
                    throw new InvalidDataException("Invalid attention preview ID.");
                if (Commands.Count >= 64) throw new InvalidDataException("Attention command queue exceeded its limit.");
                command.ReceivedAt = (long)GetTickCount64();
                Commands.Enqueue(command);
                CommandSignal.Set();
            }
        }
        catch (Exception error) { inputError = error; }
        finally { inputClosed = true; CommandSignal.Set(); }
    }

    private static void CheckLatch(bool condition)
    {
        if (!condition) throw new InvalidOperationException("Attention acknowledgment self-test failed.");
    }

    private static void SelfTest()
    {
        var latch = new AttentionLatch();
        var first = new AttentionCommand { generation = 1, kind = "approval", style = "both", color = "#FFBB24" };
        latch.Update(first, false, 0);
        for (int i = 0; i < 100000; i++) CheckLatch(latch.Show(false, 0));
        CheckLatch(!latch.Show(true, 0));
        CheckLatch(!latch.Show(false, 0));
        first.style = "border";
        latch.Update(first, false, 0);
        CheckLatch(!latch.Show(false, 0));
        latch.Update(new AttentionCommand { generation = 2, kind = "question", style = "both", color = "#B48CFF" }, false, 0);
        CheckLatch(latch.Show(false, 0));
        latch.Update(first, false, 0);
        CheckLatch(latch.Generation == 2 && latch.Show(false, 0));
        CheckLatch(!latch.Show(true, 0) && !latch.Show(false, 0));
        latch.Update(new AttentionCommand { generation = 3, kind = "ready", acknowledged = true }, false, 0);
        CheckLatch(!latch.Show(false, 0));
        latch.Update(new AttentionCommand { generation = 4, kind = null }, false, 0);
        CheckLatch(!latch.Show(false, 0));
        latch.Update(new AttentionCommand { generation = 5, kind = "question" }, true, 10);
        for (int i = 0; i < 100000; i++) CheckLatch(latch.Show(true, 10));
        CheckLatch(!latch.Show(true, 11));
        CheckLatch(!latch.Show(false, 11));
        latch.Update(new AttentionCommand { generation = 6, kind = "approval" }, true, 11);
        CheckLatch(latch.Show(true, 11));
        latch.Update(new AttentionCommand { generation = 6, kind = null }, true, 11);
        CheckLatch(!latch.Show(true, 11));
        var tracker = new AttentionFocus(new IntPtr(1), 0);
        tracker.Observe(new IntPtr(1), 0);
        tracker.Observe(new IntPtr(1), 250);
        tracker.Interact(new IntPtr(1), 300);
        var laterAlert = new AttentionLatch();
        var laterPreview = new AttentionLatch();
        var question = new AttentionCommand { generation = 1, kind = "question" };
        laterAlert.Update(question, true, tracker.InputSequence);
        laterPreview.Update(question, true, tracker.InputSequence);
        tracker.Observe(new IntPtr(1), 400);
        CheckLatch(laterAlert.Show(true, tracker.SettledInputSequence, tracker.Settled));
        tracker.Observe(new IntPtr(1), 600);
        CheckLatch(laterAlert.Show(true, tracker.SettledInputSequence, tracker.Settled));
        CheckLatch(laterPreview.Show(true, tracker.SettledInputSequence, tracker.Settled));
        tracker.Interact(new IntPtr(1), 700);
        tracker.Observe(new IntPtr(1), 1000);
        CheckLatch(!laterAlert.Show(true, tracker.SettledInputSequence, tracker.Settled));
        CheckLatch(!laterPreview.Show(true, tracker.SettledInputSequence, tracker.Settled));
        CheckLatch(IsEditingKey(0x56, false, true, true, false, false));
        CheckLatch(IsEditingKey(0x56, false, true, false, false, false));
        CheckLatch(IsEditingKey(0x43, false, true, true, false, false));
        CheckLatch(IsEditingKey(0x41, false, true, false, false, false));
        CheckLatch(IsEditingKey(0x46, false, false, false, true, false));
        CheckLatch(!IsEditingKey(0x56, true, true, true, false, false));
        CheckLatch(!IsEditingKey(0x11, false, true, false, false, false));
        CheckLatch(!IsEditingKey(0x4E, false, true, true, false, false));
        CheckLatch(!IsEditingKey(0x54, false, true, true, false, false));
        CheckLatch(!IsEditingKey(0x09, false, true, false, false, false));
        CheckLatch(!IsEditingKey(0x09, false, false, false, true, false));
        CheckLatch(!IsEditingKey(0x56, false, false, false, false, true));
        var pasted = new AttentionLatch();
        pasted.Update(question, true, tracker.InputSequence);
        if (IsEditingKey(0x56, false, true, true, false, false)) tracker.Interact(new IntPtr(1), 1100);
        tracker.Observe(new IntPtr(1), 1400);
        CheckLatch(!pasted.Show(true, tracker.SettledInputSequence, tracker.Settled));
        var delayed = new AttentionLatch();
        delayed.Update(new AttentionCommand { generation = 1, kind = "question", ReceivedAt = 500 }, true, 0);
        var delayedFocus = new AttentionFocus(new IntPtr(1), 0);
        delayedFocus.Observe(new IntPtr(1), 0);
        delayedFocus.Observe(new IntPtr(1), 250);
        delayedFocus.Interact(new IntPtr(1), 600, 400);
        delayedFocus.Observe(new IntPtr(1), 900);
        CheckLatch(delayed.Show(true, delayedFocus.SettledInputSequence, true, delayedFocus.SettledInputTimestamp));
        delayedFocus.Interact(new IntPtr(1), 1000, 1000);
        delayedFocus.Observe(new IntPtr(1), 1300);
        CheckLatch(!delayed.Show(true, delayedFocus.SettledInputSequence, true, delayedFocus.SettledInputTimestamp));
        var schedule = new AttentionFrameSchedule();
        int frames = 0;
        for (int millisecond = 0; millisecond < 10000; millisecond++) if (schedule.Take(millisecond)) frames++;
        CheckLatch(frames == 40);
        Emit(new { type = "selfTest", passed = true });
    }

    private static void PersistenceTest()
    {
        var latch = new AttentionLatch();
        var request = new AttentionCommand { generation = 1, kind = "question", style = "both", color = "#B48CFF" };
        latch.Update(request, true, 0);
        var clock = Stopwatch.StartNew();
        int samples = 0;
        while (clock.ElapsedMilliseconds < 12500)
        {
            CheckLatch(latch.Show(true, 0));
            latch.Update(request, true, 0);
            samples++;
            Thread.Sleep(50);
        }
        CheckLatch(!latch.Show(true, 1));
        CheckLatch(!latch.Show(false, 1));
        Emit(new { type = "persistenceTest", passed = true, elapsedMs = clock.ElapsedMilliseconds, samples = samples });
    }

    private static void FocusIsolationTest()
    {
        var definition = new WindowClass {
            size = (uint)Marshal.SizeOf(typeof(WindowClass)), procedure = Callback,
            instance = GetModuleHandle(null), className = ClassName
        };
        if (RegisterClassEx(ref definition) == 0) throw new Win32Exception();
        registered = true;
        IntPtr first = IntPtr.Zero, other = IntPtr.Zero, opened = IntPtr.Zero;
        try
        {
            first = CreateWindowEx(0, ClassName, "", Popup, 0, 0, 16, 16, IntPtr.Zero,
                IntPtr.Zero, definition.instance, IntPtr.Zero);
            other = CreateWindowEx(0, ClassName, "", Popup, 0, 0, 16, 16, first,
                IntPtr.Zero, definition.instance, IntPtr.Zero);
            opened = CreateWindowEx(0, ClassName, "", Popup, 0, 0, 16, 16, IntPtr.Zero,
                IntPtr.Zero, definition.instance, IntPtr.Zero);
            if (first == IntPtr.Zero || other == IntPtr.Zero || opened == IntPtr.Zero) throw new Win32Exception();
            CheckLatch(GetAncestor(other, 3) == first);
            uint firstProcess, otherProcess;
            GetWindowThreadProcessId(first, out firstProcess);
            GetWindowThreadProcessId(other, out otherProcess);
            CheckLatch(firstProcess == otherProcess);
            var tracker = new AttentionFocus(first, 0);
            var latch = new AttentionLatch();
            latch.Update(new AttentionCommand { generation = 1, kind = "question" }, false, 0);
            long time = 0;
            foreach (IntPtr foreground in new[] { other, opened, IntPtr.Zero, other, opened })
            {
                tracker.Observe(foreground, time);
                tracker.Interact(foreground, time + 10);
                tracker.Observe(foreground, time + 500);
                CheckLatch(!tracker.Focused && !tracker.Settled && tracker.InputSequence == 0);
                CheckLatch(latch.Show(tracker.Focused, tracker.SettledInputSequence, tracker.Settled));
                time += 1000;
            }
            tracker.Observe(first, time);
            CheckLatch(latch.Show(tracker.Focused, tracker.SettledInputSequence, tracker.Settled));
            tracker.Interact(first, time + 10);
            tracker.Observe(opened, time + 50);
            tracker.Observe(opened, time + 500);
            CheckLatch(tracker.SettledInputSequence == 0 &&
                latch.Show(tracker.Focused, tracker.SettledInputSequence, tracker.Settled));
            tracker.Observe(first, time + 1000);
            tracker.Observe(first, time + 1300);
            CheckLatch(!latch.Show(tracker.Focused, tracker.SettledInputSequence, tracker.Settled));
            tracker.Observe(other, time + 1500);
            CheckLatch(!latch.Show(tracker.Focused, tracker.SettledInputSequence, tracker.Settled));
            latch.Update(new AttentionCommand { generation = 2, kind = "question" }, true, tracker.InputSequence);
            tracker.Observe(first, time + 2000);
            tracker.Observe(first, time + 2300);
            CheckLatch(latch.Show(tracker.Focused, tracker.SettledInputSequence, tracker.Settled));
            tracker.Interact(first, time + 2400);
            tracker.Observe(first, time + 2700);
            CheckLatch(!latch.Show(tracker.Focused, tracker.SettledInputSequence, tracker.Settled));
            target = first;
            border = CreateWindowEx(OverlayStyle, ClassName, "", Popup, 0, 0, 16, 16, IntPtr.Zero,
                IntPtr.Zero, definition.instance, IntPtr.Zero);
            wash = CreateWindowEx(OverlayStyle, ClassName, "", Popup, 0, 0, 16, 16, IntPtr.Zero,
                IntPtr.Zero, definition.instance, IntPtr.Zero);
            CheckLatch(border != IntPtr.Zero && wash != IntPtr.Zero);
            Check(SetWindowPos(opened, new IntPtr(1), 0, 0, 16, 16, MoveFlags));
            Check(SetWindowPos(first, opened, 0, 0, 16, 16, MoveFlags));
            Check(SetWindowPos(other, opened, 0, 0, 16, 16, MoveFlags));
            Check(SetWindowPos(border, opened, 0, 0, 16, 16, MoveFlags));
            Check(SetWindowPos(wash, border, 0, 0, 16, 16, MoveFlags));
            CheckLatch(SurfaceOrderMatches("both", FindWindowOrder().Lower) && Anchor() == opened);
            Check(SetWindowPos(first, opened, 0, 0, 16, 16, MoveFlags));
            CheckLatch(Anchor() == opened && !SurfaceOrderMatches("both", FindWindowOrder().Lower));
            Check(SetWindowPos(border, opened, 0, 0, 16, 16, MoveFlags));
            Check(SetWindowPos(wash, border, 0, 0, 16, 16, MoveFlags));
            CheckLatch(SurfaceOrderMatches("both", FindWindowOrder().Lower));
            var bounds = new Rectangle { Left = 0, Top = 0, Right = 16, Bottom = 16 };
            Check(SetWindowPos(first, TopmostBand, 0, 0, 16, 16, MoveFlags));
            Check(SetWindowPos(other, first, 0, 0, 16, 16, MoveFlags));
            CheckLatch(IsTopmost(first) && !SurfaceOrderMatches("both", FindWindowOrder().Lower));
            PaintFrame("both", "#FFBB24", 0.0, bounds, false);
            CheckLatch(IsTopmost(border) && IsTopmost(wash) && SurfaceOrderMatches("both", FindWindowOrder().Lower));
            Check(SetWindowPos(first, NonTopmostBand, 0, 0, 16, 16, MoveFlags));
            Check(SetWindowPos(other, first, 0, 0, 16, 16, MoveFlags));
            CheckLatch(!IsTopmost(first) && !SurfaceOrderMatches("both", FindWindowOrder().Lower));
            PaintFrame("both", "#FFBB24", 0.25, bounds, false);
            CheckLatch(!IsTopmost(border) && !IsTopmost(wash) && SurfaceOrderMatches("both", FindWindowOrder().Lower));
            CheckLatch(!IsWindowVisible(first) && !IsWindowVisible(border) && !IsWindowVisible(wash));
            Emit(new { type = "focusIsolationTest", passed = true, sameProcessWindows = true,
                ownedWindowExcluded = true, newWindowExcluded = true, transientActivationExcluded = true,
                raisedTargetOrderRecovered = true, topmostTargetMirrored = true });
        }
        finally
        {
            if (border != IntPtr.Zero) { DestroyWindow(border); border = IntPtr.Zero; }
            if (wash != IntPtr.Zero) { DestroyWindow(wash); wash = IntPtr.Zero; }
            if (opened != IntPtr.Zero) DestroyWindow(opened);
            if (other != IntPtr.Zero) DestroyWindow(other);
            if (first != IntPtr.Zero) DestroyWindow(first);
        }
    }

    private static void ClassicConsoleHost()
    {
        TextReader input = Console.In;
        IntPtr stdin = GetStdHandle(-10), stdout = GetStdHandle(-11), stderr = GetStdHandle(-12);
        try
        {
            FreeConsole();
            Check(AllocConsole());
            ShowWindow(GetConsoleWindow(), 0);
            SetStdHandle(-10, stdin);
            SetStdHandle(-11, stdout);
            SetStdHandle(-12, stderr);
            Emit(new { type = "classicConsoleHost" });
            input.ReadLine();
        }
        finally
        {
            FreeConsole();
            SetStdHandle(-10, stdin);
            SetStdHandle(-11, stdout);
            SetStdHandle(-12, stderr);
        }
    }

    private static void GraphicsSafetyTest(IntPtr fixture)
    {
        if (!string.Equals(WindowClassName(fixture), "STATIC", StringComparison.OrdinalIgnoreCase) || IsWindowVisible(fixture))
            throw new ArgumentException("Graphics safety tests require a private hidden STATIC fixture.");
        target = fixture;
        Initialize();
        CheckLatch(GetWindow(border, 4) == IntPtr.Zero && GetWindow(wash, 4) == IntPtr.Zero);
        CheckLatch(!inputListening && !IsWindowVisible(border) && !IsWindowVisible(wash));
        Emit(new { type = "graphicsSafetyReady", windowHandle = target.ToInt64().ToString() });
        if (Console.In.ReadLine() != "run") throw new InvalidOperationException("Graphics safety test cancelled.");
        UIntPtr response;
        SafetyStage("confirm fixture hang");
        CheckLatch(SendMessageTimeout(fixture, 0, UIntPtr.Zero, IntPtr.Zero, 3, 100, out response) == IntPtr.Zero);
        positionCalls = alphaCalls = visibilityCalls = 0;
        var rectangle = new Rectangle { Left = 0, Top = 0, Right = 320, Bottom = 200 };
        FrameSchedule.Reset();
        int frames = 0;
        SafetyStage("hidden frames");
        for (int milliseconds = 0; milliseconds < 10000; milliseconds++)
        {
            if (!FrameSchedule.Take(milliseconds)) continue;
            PumpMessages();
            PaintFrame("both", "#FFBB24", milliseconds / 1000.0, rectangle, false);
            frames++;
        }
        CheckLatch(frames == 40 && positionCalls == 2 && alphaCalls <= 80 && visibilityCalls == 0);
        CheckLatch(!IsWindowVisible(border) && !IsWindowVisible(wash));
        CheckLatch(GetForegroundWindow() != border && GetForegroundWindow() != wash);
        long measuredPositionCalls = positionCalls, measuredAlphaCalls = alphaCalls;
        SafetyStage("message batch");
        for (int message = 0; message < 1000; message++) Check(PostMessage(wash, 0x8001, UIntPtr.Zero, IntPtr.Zero));
        int pumped = PumpMessages();
        CheckLatch(pumped > 0 && pumped <= MessageBatchLimit);
        Message pending;
        CheckLatch(PeekMessage(out pending, IntPtr.Zero, 0, 0, 0));
        Cleanup();
        PumpMessages();
        uint gdiBefore = GetGuiResources(GetCurrentProcess(), 0);
        uint userBefore = GetGuiResources(GetCurrentProcess(), 1);
        uint handlesBefore;
        SafetyStage("resource baseline");
        Check(GetProcessHandleCount(GetCurrentProcess(), out handlesBefore));
        for (int cycle = 0; cycle < 20; cycle++)
        {
            SafetyStage("resource cycle " + cycle);
            Initialize();
            PumpMessages();
            PaintFrame("both", "#FFBB24", 0.5, rectangle, false);
            Cleanup();
            PumpMessages();
        }
        uint gdiAfter = GetGuiResources(GetCurrentProcess(), 0);
        uint userAfter = GetGuiResources(GetCurrentProcess(), 1);
        uint handlesAfter;
        SafetyStage("resource totals");
        Check(GetProcessHandleCount(GetCurrentProcess(), out handlesAfter));
        CheckLatch(gdiAfter <= gdiBefore && userAfter <= userBefore && handlesAfter <= handlesBefore);
        ReadCommands(Console.In);
        CheckLatch(inputClosed && inputError == null);
        SafetyStage("message-aware wait");
        WaitForWork(100);
        Emit(new {
            type = "graphicsSafetyTest", passed = true, frames = frames,
            positionCalls = measuredPositionCalls, alphaCalls = measuredAlphaCalls, pumpedMessages = pumped,
            gdiBefore = gdiBefore, gdiAfter = gdiAfter, userBefore = userBefore, userAfter = userAfter,
            handlesBefore = handlesBefore, handlesAfter = handlesAfter, visibleOverlays = 0,
            foreignUnresponsive = true, unownedOverlays = true
        });
    }

    private static void SafetyStage(string stage)
    {
        safetyStage = stage;
        Console.Error.WriteLine("graphics-safety: " + stage);
        Console.Error.Flush();
    }

    [STAThread]
    private static int Main(string[] args)
    {
        output = Console.Out;
        try
        {
            if (args.Length == 1 && args[0] == "--self-test") { SelfTest(); return 0; }
            if (args.Length == 1 && args[0] == "--persistence-test") { PersistenceTest(); return 0; }
            if (args.Length == 1 && args[0] == "--focus-isolation-test") { FocusIsolationTest(); return 0; }
            if (args.Length == 1 && args[0] == "--classic-console-host") { ClassicConsoleHost(); return 0; }
            if (args.Length == 2 && args[0] == "--lease-probe")
            {
                target = new IntPtr(long.Parse(args[1], CultureInfo.InvariantCulture));
                AcquireWindowLease();
                Emit(new { type = "leaseProbe", acquired = true });
                return 0;
            }
            if (args.Length == 2 && args[0] == "--graphics-safety-test")
            {
                GraphicsSafetyTest(new IntPtr(long.Parse(args[1], CultureInfo.InvariantCulture)));
                return 0;
            }
            uint ownerId;
            if (args.Length < 1 || !uint.TryParse(args[0], out ownerId) || ownerId == 0)
                throw new ArgumentException("A live session process ID is required.");
            bool diagnostics = args.Length == 2 && args[1] == "--diagnostics";
            using (Process owner = Process.GetProcessById((int)ownerId))
            {
                TextReader input = Console.In;
                Bind(ownerId);
                if (args.Length == 2 && args[1] == "--probe")
                {
                    Emit(new { type = "ready", windowHandle = target.ToInt64().ToString(),
                        consoleWindow = consoleWindow.ToInt64().ToString() });
                    return 0;
                }
                Initialize();
                var reader = new Thread(delegate() { ReadCommands(input); }) { IsBackground = true };
                reader.Start();
                Emit(new { type = "ready", windowHandle = target.ToInt64().ToString() });
                var clock = Stopwatch.StartNew();
                long nextHeartbeat = 0;
                var latch = new AttentionLatch();
                AttentionLatch preview = null;
                while (!inputClosed && !owner.HasExited && IsWindow(consoleWindow))
                {
                    PumpMessages();
                    if (clock.ElapsedMilliseconds >= nextHeartbeat)
                    {
                        if (diagnostics)
                        {
                            uint cloak;
                            bool cloakKnown = DwmGetWindowValue(target, 14, out cloak, sizeof(uint)) == 0;
                            string style = preview != null ? preview.Style : latch.Style;
                            Emit(new {
                                type = "heartbeat", windowHandle = target.ToInt64().ToString(),
                                borderVisible = IsWindowVisible(border), washVisible = IsWindowVisible(wash),
                                ordered = SurfaceOrderMatches(style, FindWindowOrder().Lower), foreground = TargetFocused(),
                                targetVisible = IsWindowVisible(target), targetEnabled = IsWindowEnabled(target),
                                targetMinimized = IsIconic(target), targetCloaked = cloakKnown ? (object)cloak : null,
                                x = lastX, y = lastY, width = lastWidth, height = lastHeight,
                                frames = paintedFrames, positionCalls = positionCalls, alphaCalls = alphaCalls
                            });
                        }
                        else Emit(new { type = "heartbeat", windowHandle = target.ToInt64().ToString() });
                        nextHeartbeat = clock.ElapsedMilliseconds + 1000;
                    }
                    focus.Observe(GetForegroundWindow(), FocusClock.ElapsedMilliseconds);
                    inputSequence = focus.InputSequence;
                    IntPtr currentTarget = TerminalOwner(consoleWindow);
                    if (currentTarget == IntPtr.Zero)
                    {
                        SetInputListening(false);
                        Hide();
                        WaitForWork(100);
                        continue;
                    }
                    if (currentTarget != target)
                    {
                        Cleanup();
                        target = currentTarget;
                        Initialize();
                        Emit(new { type = "binding", windowHandle = target.ToInt64().ToString() });
                    }
                    AttentionCommand command;
                    for (int count = 0; count < 64 && Commands.TryDequeue(out command); count++)
                    {
                        if (command.type == "preview")
                        {
                            preview = new AttentionLatch();
                            preview.Update(command, TargetFocused(), inputSequence);
                        }
                        else
                        {
                            latch.Update(command, TargetFocused(), inputSequence);
                        }
                    }
                    bool focused = focus.Focused;
                    bool acknowledged = latch.Acknowledged;
                    bool visible = latch.Show(focused, focus.SettledInputSequence, focus.Settled, focus.SettledInputTimestamp);
                    if (!acknowledged && latch.Acknowledged)
                        Emit(new { type = "acknowledged", generation = latch.Generation,
                            windowHandle = target.ToInt64().ToString() });
                    if (preview != null && !preview.Show(focused, focus.SettledInputSequence, focus.Settled, focus.SettledInputTimestamp))
                    {
                        string completedId = preview.PreviewId;
                        preview = null;
                        Emit(new { type = "previewComplete", windowHandle = target.ToInt64().ToString(), previewId = completedId });
                    }
                    SetInputListening((preview != null || visible) && focused);
                    if (preview != null) Render(preview.Style, preview.Color, clock.ElapsedMilliseconds);
                    else if (visible) Render(latch.Style, latch.Color, clock.ElapsedMilliseconds);
                    else Hide();
                    WaitForWork(preview != null || visible ? FrameSchedule.Delay(clock.ElapsedMilliseconds) : 100);
                }
                if (inputError != null) throw inputError;
            }
            return 0;
        }
        catch (Exception error)
        {
            try
            {
                if (args.Length > 0 && args[0] == "--graphics-safety-test")
                    Emit(new { type = "unavailable", message = error.Message, stage = safetyStage, detail = error.ToString() });
                else Emit(new { type = "unavailable", message = error.Message });
            }
            catch (IOException) { }
            return 1;
        }
        finally { Cleanup(); }
    }
}
