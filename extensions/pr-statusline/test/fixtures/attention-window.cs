using System;
using System.Runtime.InteropServices;
using System.Threading;

internal static class AttentionWindowFixture
{
    [StructLayout(LayoutKind.Sequential)]
    private struct Message
    {
        public IntPtr window;
        public uint message;
        public UIntPtr parameter;
        public IntPtr value;
        public uint time;
        public int x, y;
        public uint privateData;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateWindowEx(uint extendedStyle, string className, string title, uint style,
        int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool DestroyWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool PeekMessage(out Message message, IntPtr window, uint min, uint max, uint remove);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr DispatchMessage(ref Message message);

    [STAThread]
    private static int Main()
    {
        IntPtr window = CreateWindowEx(0, "STATIC", "Private attention safety fixture", 0x80000000,
            0, 0, 320, 200, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        if (window == IntPtr.Zero) return 1;
        int done = 0, hang = 0;
        bool reported = false;
        Console.WriteLine("{\"type\":\"fixtureReady\",\"windowHandle\":\"" + window.ToInt64() + "\"}");
        Console.Out.Flush();
        var reader = new Thread(delegate() {
            try
            {
                string line;
                while ((line = Console.ReadLine()) != null)
                    if (line == "hang") Interlocked.Exchange(ref hang, 1);
            }
            finally { Interlocked.Exchange(ref done, 1); }
        }) { IsBackground = true };
        reader.Start();
        try
        {
            while (Interlocked.CompareExchange(ref done, 0, 0) == 0)
            {
                if (Interlocked.CompareExchange(ref hang, 0, 0) == 0)
                {
                    Message message;
                    while (PeekMessage(out message, IntPtr.Zero, 0, 0, 1))
                    {
                        TranslateMessage(ref message);
                        DispatchMessage(ref message);
                    }
                }
                else if (!reported)
                {
                    Console.WriteLine("{\"type\":\"fixtureHung\"}");
                    Console.Out.Flush();
                    reported = true;
                }
                Thread.Sleep(10);
            }
            return 0;
        }
        finally { DestroyWindow(window); }
    }
}
